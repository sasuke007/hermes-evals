/**
 * One trial container's life (plan 8.2, 8.3): create, record it, start,
 * stream its output into the sink, stop it when it must stop, and remove it.
 * runTrial (sandbox/trial-runner.ts) owns the container; this adds what an
 * attempt needs around it:
 * - the container id and daemon id are recorded through the sink right
 *   after create and before start, so recovery can find the container if
 *   this worker dies;
 * - every stdout line becomes an event (stream-json.ts), redacted, and goes
 *   to the sink through the batcher; stderr goes to stderr.log. stdout is
 *   capped in lines as well as bytes (maxLines), and an event backlog past
 *   the batcher's bound stops the trial the same way: `output_limit`;
 * - only the first `result` line is Hermes's answer. Hermes prints exactly
 *   one, and anything in the container can print more to the same stream,
 *   so a later one is stored as `unmapped` and changes nothing;
 * - Cancel is polled from the sink about once a second, and the lifecycle's
 *   signal is followed: a cancel stops the container and the attempt ends
 *   `cancelled`; a lost lease, a worker shutdown or a sink write that failed
 *   for good stops it and is handed back to be rethrown. A poll that fails
 *   for any other reason (a database blip) is only tried again: a database
 *   that cannot answer says nothing about the cancel or the lease, and the
 *   lease keeper watches both too.
 *
 * Every stop condition (deadline, disk, output, cancel) is armed by runTrial
 * right after start, before any output is read.
 */
import type { RunEventPayload } from '@hermes-evals/shared';
import type { EngineClient } from '../../sandbox/engine-client.js';
import type { DiskLimit } from '../../sandbox/trial-files.js';
import { runTrial, type TrialOutcome } from '../../sandbox/trial-runner.js';
import type { TrialSpec } from '../../sandbox/trial-spec.js';
import { LeaseLostError, WorkerShutdownError, type AttemptSink } from '../contracts.js';
import { parseStreamLine } from '../stream-json.js';
import type { EventBatcher } from './event-batcher.js';
import type { Redactor } from './redaction.js';
import type { StderrCapture } from './stderr-capture.js';

export interface SessionInput {
  engine: EngineClient;
  /** This worker's Docker daemon id, recorded with the container. */
  hostId: string;
  spec: TrialSpec;
  deadlineMs: number;
  stopGraceS: number;
  diskLimit: DiskLimit;
  outputLimitBytes: number;
  /** Most stdout lines (each one an event); past it the trial is killed as for output. */
  maxLines: number;
  cancelPollMs: number;
  sink: AttemptSink;
  signal: AbortSignal;
  batcher: EventBatcher;
  redactor: Redactor;
  stderr: StderrCapture;
  now: () => number;
}

export interface SessionResult {
  /** Null when no container ran to completion: create or start failed, or the engine failed mid-run. */
  trial: TrialOutcome | null;
  /** Why the container could not be created or started. */
  setupError: string | null;
  /** The engine failed after the trial started (the output stream, wait or inspect). */
  engineError: string | null;
  /** The stop was a cancel. */
  cancelled: boolean;
  /** Stops to hand back to the lifecycle: a LeaseLostError, WorkerShutdownError or failed sink write. */
  fatal: { error: unknown } | null;
  /** The first `result` event, redacted: Hermes's own. Later ones are stored as `unmapped`. */
  result: Record<string, unknown> | null;
  sawInit: boolean;
}

const isHandBack = (reason: unknown): boolean =>
  reason instanceof LeaseLostError || reason instanceof WorkerShutdownError;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runTrialSession(input: SessionInput): Promise<SessionResult> {
  const { sink, batcher, redactor } = input;
  const state: SessionResult = {
    trial: null,
    setupError: null,
    engineError: null,
    cancelled: false,
    fatal: null,
    result: null,
    sawInit: false,
  };
  const stop = new AbortController();
  const halt = (why: 'cancel' | 'fatal', error?: unknown) => {
    if (why === 'fatal') state.fatal ??= { error };
    else if (!state.fatal) state.cancelled = true;
    stop.abort();
  };
  batcher.onFailure = (error) => halt('fatal', error);
  // A backlog the sink cannot drain stops the trial as too much output, not as a fault.
  const overflow = new AbortController();
  batcher.onOverflow = (queued) =>
    overflow.abort(`the event backlog passed ${queued} events the database had not taken`);
  // The lifecycle aborts for a cancel, a lost lease or a shutdown; only the last two go back up.
  const onAbort = () =>
    isHandBack(input.signal.reason) ? halt('fatal', input.signal.reason) : halt('cancel');
  if (input.signal.aborted) onAbort();
  else input.signal.addEventListener('abort', onAbort, { once: true });

  let done = false;
  let pollTimer: NodeJS.Timeout | undefined;
  const poll = () => {
    pollTimer = setTimeout(async () => {
      try {
        if (!done && (await sink.cancelRequested())) halt('cancel');
      } catch (error) {
        if (error instanceof LeaseLostError) halt('fatal', error);
      }
      if (!done && !stop.signal.aborted) poll();
    }, input.cancelPollMs);
  };

  let created = false;
  let output = false;
  try {
    state.trial = await runTrial({
      engine: input.engine,
      spec: input.spec,
      deadlineMs: input.deadlineMs,
      stopGraceSeconds: input.stopGraceS,
      diskLimit: input.diskLimit,
      outputLimit: { maxBytes: input.outputLimitBytes, maxLines: input.maxLines },
      outputStop: overflow.signal,
      signal: stop.signal,
      onCreated: async (containerId) => {
        created = true;
        try {
          await sink.recordContainer(containerId, input.hostId);
        } catch (error) {
          state.fatal ??= { error };
          throw error;
        }
        batcher.push({
          ts: input.now(),
          type: 'platform',
          payload: {
            type: 'platform',
            subtype: 'started',
            container_id: containerId,
            network: input.spec.network,
            image: input.spec.image,
            deadline_ms: input.deadlineMs,
          },
        });
        poll();
      },
      onStdoutLine: (line) => {
        output = true;
        const at = input.now();
        let event = parseStreamLine(line, at);
        // A noise line is cut to NOISE_LINE_MAX_CHARS when stored; redact it whole first, so the
        // cut cannot leave the start of a value behind.
        if (event.payload.subtype === 'noise' && redactor.holdsValue(line)) {
          event = parseStreamLine(redactor.text(line), at);
        }
        const payload: RunEventPayload = redactor.json(event.payload);
        if (event.type === 'result') {
          if (state.result !== null) {
            // A second result is not Hermes's: kept for the record, read for nothing.
            batcher.push({
              ts: at,
              type: 'platform',
              payload: {
                type: 'platform',
                subtype: 'unmapped',
                reason: 'a later result line',
                event: payload,
              },
            });
            return;
          }
          state.result = { ...payload };
        }
        if (event.type === 'system' && payload.subtype === 'init') state.sawInit = true;
        batcher.push({ ...event, payload });
      },
      onStderr: (chunk) => {
        output = true;
        input.stderr.push(chunk);
      },
    });
  } catch (err) {
    if (!state.fatal && isHandBack(err)) state.fatal = { error: err };
    if (!state.fatal) {
      const message = redactor.text(messageOf(err));
      if (!created) state.setupError = `The trial container could not be created: ${message}`;
      else if (!output) state.setupError = `The trial container could not be started: ${message}`;
      else state.engineError = message;
    }
  } finally {
    done = true;
    clearTimeout(pollTimer);
    input.signal.removeEventListener('abort', onAbort);
  }
  return state;
}
