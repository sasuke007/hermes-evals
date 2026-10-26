/**
 * Runs one verifier container to its exit or its deadline (plan 14, R7):
 * create through docker-guard, wait registered before start, the script's
 * stdout and stderr read from the multiplexed log stream into bounded tails
 * and its last non-empty stdout line, SIGKILL at the deadline, and the
 * container removed whatever happens. The caller fills and removes the
 * scratch subpath it mounts (scoring/verifier-runner.ts).
 *
 * The deadline counts from start, as the subprocess runner's counts from
 * spawn, so creating the container does not eat into the script's time.
 * Killing the container ends every process the script started, as killing
 * its process group did.
 */
import { performance } from 'node:perf_hooks';
import { EngineError, type EngineClient } from './engine-client.js';
import { ByteTail, FrameDecoder, LineSplitter } from './streams.js';
import {
  verifierContainerBody,
  verifierContainerName,
  type VerifierContainerSpec,
} from './verifier-spec.js';

/** After the exit, how long the log stream may take to end before it is cut. */
const LOG_DRAIN_MS = 5000;

export interface VerifierContainerOptions {
  engine: EngineClient;
  spec: VerifierContainerSpec;
  /** From start; the container is killed when it passes. */
  timeoutMs: number;
  /** Bytes kept of each stream's end. */
  tailBytes: number;
  /** A stdout line longer than this is cut, as the subprocess runner cuts it. */
  maxLineBytes: number;
}

export interface VerifierContainerRun {
  /** The container's exit code; 137 after the deadline's kill. */
  exitCode: number;
  timedOut: boolean;
  oomKilled: boolean;
  /** From start to exit. */
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /** The last non-empty stdout line, trimmed. */
  lastLine: string | null;
  /** Set when the log stream failed, so output may be missing. */
  logError?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function oomKilledAfterExit(engine: EngineClient, id: string): Promise<boolean> {
  try {
    return (await engine.inspect(id)).State.OOMKilled;
  } catch (err) {
    if (err instanceof EngineError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Creates, starts and follows the container. Throws when it cannot be
 * created or started (docker-guard down or refusing, the image missing):
 * nothing ran then. Anything after start is the run's outcome.
 */
export async function runVerifierContainer(
  options: VerifierContainerOptions,
): Promise<VerifierContainerRun> {
  const { engine, spec } = options;
  const id = await engine.createContainer(
    verifierContainerName(spec.id),
    verifierContainerBody(spec),
  );
  try {
    const { registered, exited } = engine.waitForExit(id);
    await registered;
    await engine.start(id);
    const started = performance.now();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // A kill that fails leaves the wait to end at the final remove.
      void engine.kill(id).catch(() => {});
    }, options.timeoutMs);

    const stdoutTail = new ByteTail(options.tailBytes);
    const stderrTail = new ByteTail(options.tailBytes);
    // An object, so the callback's writes are visible after the await.
    const stdout: { lastLine: string | null } = { lastLine: null };
    const lines = new LineSplitter((line) => {
      if (line.trim() !== '') stdout.lastLine = line.trim();
    }, options.maxLineBytes);
    const frames = new FrameDecoder(
      (chunk) => {
        stdoutTail.push(chunk);
        lines.push(chunk);
      },
      (chunk) => stderrTail.push(chunk),
    );
    const logs = engine.logs(id);
    const drained = logs.then(async (stream) => {
      for await (const chunk of stream) frames.push(chunk as Buffer);
    });
    let logError: string | undefined;
    drained.catch((err: Error) => (logError = err.message));

    let exitCode: number;
    try {
      ({ StatusCode: exitCode } = await exited);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Math.round(performance.now() - started);
    await Promise.race([
      drained.catch(() => {}),
      sleep(LOG_DRAIN_MS).then(async () => (await logs.catch(() => null))?.destroy()),
    ]);
    lines.end();
    return {
      exitCode,
      timedOut,
      oomKilled: await oomKilledAfterExit(engine, id).catch(() => false),
      durationMs,
      stdoutTail: stdoutTail.text(),
      stderrTail: stderrTail.text(),
      lastLine: stdout.lastLine,
      ...(logError ? { logError } : {}),
    };
  } finally {
    // One left behind (docker-guard gone meanwhile) is swept by recovery once its deadline passes.
    await engine.remove(id).catch(() => {});
  }
}
