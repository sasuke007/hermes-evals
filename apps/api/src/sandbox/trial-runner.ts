/**
 * Runs one trial container to completion. Stopping the container is the only
 * reliable way to end a Hermes run: the agent loop lives in a gateway daemon
 * that survives its client, and stopping the container ends every process in
 * its PID namespace.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EngineError, type EngineClient } from './engine-client.js';
import { FrameDecoder, LineSplitter } from './streams.js';
import {
  DEFAULT_DISK_LIMIT,
  measureTrialDisk,
  restoreOwnerAccess,
  type DiskLimit,
} from './trial-files.js';
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
  /** stdout lines read after the line cap and not forwarded; absent when none were. */
  droppedLines?: number;
  /** Set when the output stream failed, so events may be missing. */
  logError?: string;
  /** Set when stopping or killing the container failed; the final remove still forces it. */
  stopError?: string;
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
   * Stops the trial when its stdout and stderr together pass `maxBytes`, or
   * its stdout passes `maxLines` lines, and forwards nothing past either.
   * The output is decoded in the worker's memory and each line becomes a
   * stored event, and what runs in the container is arbitrary code that can
   * write to its streams at pipe speed: without both caps two-byte lines
   * alone could exhaust the worker's heap and fill run_events.
   */
  outputLimit?: { maxBytes: number; maxLines?: number };
  /**
   * Aborting stops the trial as a passed output cap does (SIGKILL, stop
   * reason `output_limit`), with the abort reason, a string, as its detail.
   * The caller's own output bounds use it (the event backlog).
   */
  outputStop?: AbortSignal;
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

/**
 * Deletes a tree a trial wrote, even one whose directories the agent made
 * unwritable or unlistable (it shares the worker's uid, so `chmod 500` on a
 * directory it created makes rm fail with EACCES, or ENOTEMPTY on macOS).
 * On those the worker restores its owner permissions on every directory
 * (restoreOwnerAccess, which never follows a link) and tries again. Call it
 * only once the trial's container is gone, so nothing changes under the walk.
 */
export async function forceRemoveTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    if (!LOCKED_TREE_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
    await restoreOwnerAccess(path);
    await rm(path, { recursive: true, force: true });
  }
}

/** How rm reports a directory it may not empty: what restoring owner permissions fixes. */
const LOCKED_TREE_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ENOTEMPTY']);

/** Deletes an attempt's directory tree (home and workspace); used after probes and by retention. */
export async function removeTrialDirs(trialsDir: string, attemptId: string): Promise<void> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(attemptId))
    throw new Error(`not an attempt id: ${attemptId}`);
  await forceRemoveTree(join(trialsDir, attemptId));
}

/**
 * Whether the kernel's OOM killer ended the container, read once it exited.
 * A container someone else removed after it exited (recovery's sweep, say)
 * answers 404: it keeps the exit code and stop reason it ended with, and an
 * OOM kill would have to be read before the removal, so it counts as none.
 */
async function oomKilledAfterExit(engine: EngineClient, containerId: string): Promise<boolean> {
  try {
    return (await engine.inspect(containerId)).State.OOMKilled;
  } catch (err) {
    if (err instanceof EngineError && err.status === 404) return false;
    throw err;
  }
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
    let stopError: string | undefined;
    const stopFailed = (err: unknown) => {
      stopError ??= err instanceof Error ? err.message : String(err);
    };
    const stop = (reason: TrialOutcome['stopReason']) => {
      if (stopReason === 'exited') stopReason = reason;
      // A runaway writer gets no grace period: every second of it is more disk or memory.
      // Neither call may reject unhandled: that would end the worker with every trial it runs.
      // If both fail, the wait still ends runTrial and the final remove forces the container.
      if (reason === 'disk_limit' || reason === 'output_limit')
        void engine.kill(containerId).catch(stopFailed);
      else
        void engine
          .stop(containerId, grace)
          .catch(() => engine.kill(containerId))
          .catch(stopFailed);
    };
    let limitDetail: string | undefined;
    /** Stops for a passed cap; the first stop's reason and detail are the ones kept. */
    const stopForLimit = (reason: 'disk_limit' | 'output_limit', detail: string) => {
      if (stopReason === 'exited') limitDetail = detail;
      stop(reason);
    };
    const timer = setTimeout(() => stop('deadline'), options.deadlineMs);
    const onAbort = () => stop('cancelled');
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const onOutputStop = () =>
      stopForLimit('output_limit', String(options.outputStop?.reason ?? 'output bound passed'));
    if (options.outputStop?.aborted) onOutputStop();
    options.outputStop?.addEventListener('abort', onOutputStop, { once: true });

    let finished = false;
    let watchTimer: NodeJS.Timeout | undefined;
    const limit = options.diskLimit;
    const watch = () => {
      if (!limit) return;
      watchTimer = setTimeout(async () => {
        const usage = await measureTrialDisk(limit).catch(() => null);
        if (finished) return;
        if (usage?.exceeded) {
          stopForLimit('disk_limit', usage.exceeded);
        } else {
          watch();
        }
      }, limit.intervalMs ?? DEFAULT_DISK_LIMIT.intervalMs);
    };
    watch();

    const maxLines = options.outputLimit?.maxLines;
    let stdoutLines = 0;
    let droppedLines = 0;
    const lines = new LineSplitter((line) => {
      if (maxLines !== undefined && stdoutLines >= maxLines) {
        if (droppedLines === 0) stopForLimit('output_limit', `stdout passed ${maxLines} lines`);
        droppedLines += 1;
        return;
      }
      stdoutLines += 1;
      options.onStdoutLine(line);
    });
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
        stopForLimit('output_limit', `stdout and stderr passed ${maxOutput} bytes`);
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
      options.outputStop?.removeEventListener('abort', onOutputStop);
    }
    // Logs end shortly after exit; do not wait forever on a stuck stream.
    await Promise.race([
      drained.catch(() => {}),
      sleep(5000).then(async () => (await logs.catch(() => null))?.destroy()),
    ]);
    return {
      containerId,
      exitCode,
      oomKilled: await oomKilledAfterExit(engine, containerId),
      stopReason,
      ...(limitDetail ? { limitDetail } : {}),
      ...(droppedLines > 0 ? { droppedLines } : {}),
      ...(logError ? { logError } : {}),
      ...(stopError ? { stopError } : {}),
      durationMs: Date.now() - started,
    };
  } finally {
    await engine.remove(containerId);
  }
}
