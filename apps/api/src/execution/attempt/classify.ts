/**
 * How an attempt ended (plan 8.4), from what the runner observed: whether the
 * container ran and why it stopped, and Hermes's `result` event.
 *
 * What the Hermes source at 4d04303 says about its exits, which the rows
 * below rely on (hermes_cli/gateway_chat.py, gateway_chat_view.py,
 * stream_json.py, turn_exit.py):
 * - Every stream-json run ends with exactly one `result`, failures included:
 *   a start that fails ("credentials or agent init failed", an unreadable or
 *   empty --query-file, a lost gateway daemon) emits `init` and a `result`
 *   with `error` set and exit 1 or 2. So "Hermes failed before init" shows as
 *   a result with one of those errors, or as no output at all.
 * - A provider failure is a `result` with exit 1, `error` set (e.g.
 *   "Connection error.") and Hermes's human message in `text`: classify on
 *   `error` before looking at `text`.
 * - A turn stopped by --max-turns settles with exit 1 and the text it has.
 * - Exit 3 is a one-shot run that needed a human ("Input required").
 * - Exit 130 is an interrupted turn.
 */
import type { ExecutionErrorCategory, Tokens } from '@hermes-evals/shared';
import type { TrialOutcome } from '../../sandbox/trial-runner.js';
import type { AttemptOutcome } from '../contracts.js';
import { firstLine as stderrFirstLine } from '../lifecycle/first-line.js';
import { resultTokens } from '../stream-json.js';
import { mcpStartMessage, type McpStartFailure } from './mcp-start.js';

/** Errors of a run that never reached the model: Hermes, its gateway daemon or its input. */
const SETUP_ERROR =
  /credentials or agent init failed|--query-file|gateway connection\/read failed|noninteractive chat requires|unknown provider|unsupported|input required|unknown execution blocks/i;
/** Authentication refused by the provider (plan 8.4: auth, 401, 403). */
const AUTH_ERROR =
  /\b40[13]\b|unauthori[sz]ed|forbidden|authenticat|invalid[ _-]?api[ _-]?key|\bauth\b/i;
/** The provider was unreachable, limited or failing (plan 8.4: 429, 5xx, connection). */
const PROVIDER_ERROR =
  /\b429\b|\b5\d\d\b|rate[ _-]?limit|too many requests|quota|connection|connect error|econn|enotfound|eai_again|timed? ?out|overloaded|unavailable|bad gateway/i;
/** Hermes's report of an MCP server that would not start, when nothing else ran. */
const MCP_START_FAILURE = /mcp server .{0,80}(failed|could not|error)/i;

/** Longest error text kept in a message. */
const MAX_DETAIL = 500;
const cut = (text: string): string =>
  text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}...` : text;

export interface AttemptObservation {
  /** The trial runner's outcome; null when no container ran. */
  trial: TrialOutcome | null;
  /** Why the trial could not be set up or started, when it could not. */
  setupError: string | null;
  /** The engine failed after the trial started (no outcome to classify). */
  engineError: string | null;
  /** The stop was a cancel (the user's, or the lifecycle's abort for one). */
  cancelled: boolean;
  /** The last `result` event Hermes printed (redacted), or null. */
  result: Record<string, unknown> | null;
  /** Whether Hermes printed its `system/init` event. */
  sawInit: boolean;
  /** The redacted stderr tail, for setup failures that leave no result. */
  stderrTail: string | null;
  /** Configured MCP servers Hermes's errors.log says failed to connect (mcp-start.ts). */
  mcpStartFailures: readonly McpStartFailure[];
  runBudgetS: number;
  deadlineGraceS: number;
  memoryMiB: number;
}

export type Classification = Pick<
  AttemptOutcome,
  'status' | 'category' | 'errorMessage' | 'exitCode' | 'finalText' | 'sessionId' | 'tokens'
>;

const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
};

export function classifyAttempt(obs: AttemptObservation): Classification {
  const { trial, result } = obs;
  const finalText = result ? (stringField(result, 'text') ?? '') : null;
  const sessionId = stringField(result, 'session_id') || null;
  const tokens: Tokens | null = result ? resultTokens(result) : null;
  const exitCode = trial ? trial.exitCode : null;
  const base = { exitCode, finalText, sessionId, tokens };
  const error = (category: ExecutionErrorCategory, message: string): Classification => ({
    ...base,
    status: 'execution_error',
    category,
    errorMessage: message,
  });
  const executed = (text: string): Classification => ({
    ...base,
    finalText: text,
    status: 'executed',
    category: null,
    errorMessage: null,
  });

  if (obs.cancelled) return { ...base, status: 'cancelled', category: null, errorMessage: null };
  if (!trial) {
    if (obs.setupError === null && obs.engineError !== null) {
      return error('other', `The container engine failed during the run: ${cut(obs.engineError)}`);
    }
    return error('setup', obs.setupError ?? 'The trial container could not be started.');
  }
  if (trial.stopReason === 'disk_limit') {
    return error(
      'other',
      `Stopped for writing too much to disk: ${trial.limitDetail ?? 'over the cap'}.`,
    );
  }
  if (trial.stopReason === 'output_limit') {
    return error(
      'other',
      `Stopped for printing too much output: ${trial.limitDetail ?? 'over the cap'}.`,
    );
  }
  if (trial.oomKilled) {
    return error(
      'other',
      `The container ran out of memory (limit ${obs.memoryMiB} MiB) and was killed.`,
    );
  }
  // Hermes runs on without a server that failed to start and still ends with a
  // result, which would score the agent without the tools the configuration gives it.
  if (obs.mcpStartFailures.length > 0) {
    return error('setup', mcpStartMessage(obs.mcpStartFailures));
  }
  const deadline =
    `Stopped at the deadline: the run budget of ${obs.runBudgetS} s plus ` +
    `${obs.deadlineGraceS} s passed`;

  if (result) {
    const code = typeof result.exit_code === 'number' ? result.exit_code : trial.exitCode;
    const failure = stringField(result, 'error');
    if (code === 3) {
      return error(
        'setup',
        `Hermes stopped for input a one-shot run cannot get (exit 3): ${cut(failure ?? '')}`.trim(),
      );
    }
    if (failure !== null && failure !== '') {
      if (SETUP_ERROR.test(failure))
        return error('setup', `Hermes could not start the run: ${cut(failure)}`);
      if (AUTH_ERROR.test(failure))
        return error('provider', `The provider refused the request: ${cut(failure)}`);
      if (PROVIDER_ERROR.test(failure))
        return error('provider', `The provider failed: ${cut(failure)}`);
    }
    // Scored on what it produced: an answer, or the partial text of a stopped turn.
    if (finalText) {
      if (trial.stopReason === 'deadline' && code !== 0) return error('timeout', `${deadline}.`);
      return executed(finalText);
    }
    if (code === 0 && !failure) return executed('');
    if (trial.stopReason === 'deadline') return error('timeout', `${deadline}.`);
    return error(
      'other',
      failure ? `Hermes failed: ${cut(failure)}` : `Hermes ended with code ${code} and no answer.`,
    );
  }

  if (trial.stopReason === 'deadline') return error('timeout', `${deadline} without a result.`);
  const logLost = trial.logError ? ` The output stream failed: ${trial.logError}.` : '';
  if (trial.exitCode === 3) {
    return error('setup', `Hermes stopped for input a one-shot run cannot get (exit 3).${logLost}`);
  }
  // The first line that says something: Hermes's session banner never does.
  const firstLine = stderrFirstLine(obs.stderrTail);
  if (!obs.sawInit || (obs.stderrTail !== null && MCP_START_FAILURE.test(obs.stderrTail))) {
    return error(
      'setup',
      `Hermes exited with code ${trial.exitCode} before it started the run` +
        `${firstLine ? `: ${cut(firstLine)}` : '.'}${logLost}`,
    );
  }
  return error('other', `Hermes exited with code ${trial.exitCode} without a result.${logLost}`);
}
