/**
 * Why an experiment stopped or waits, in words: the circuit breaker's failure
 * as the Overview banner shows it (UI_FLOWS 14.2), and the one-line status
 * reason of the Experiment list's chip tooltip.
 */
import type {
  ExperimentFailure,
  ExperimentFailureView,
  ExperimentStatus,
  PauseReason,
  Provider,
  RunCounts,
} from '@hermes-evals/shared';
import { firstLine } from '../../execution/lifecycle/first-line.js';
import type { ErrorRunFacts, McpSecretFacts } from './queries.js';

/**
 * Runs that ended the same way as the tripping attempt: the same first
 * stderr line when the failure has one, else the same error category. The
 * breaker stored its line through firstLine (cut to 500 characters), so
 * every run's tail goes through the same helper, and both sides are trimmed
 * alike, before they are compared.
 */
export function identicalIn(
  failure: ExperimentFailure,
  errorRuns: readonly ErrorRunFacts[],
): number {
  const line = failure.stderr_first_line?.trim() || null;
  if (line !== null) {
    return errorRuns.filter((r) => firstLine(r.stderrTail)?.trim() === line).length;
  }
  return errorRuns.filter((r) => r.category === failure.category).length;
}

/** `NAME` as a whole word: not part of a longer variable name. */
const mentions = (text: string, word: string): boolean =>
  new RegExp(
    `(^|[^A-Za-z0-9_-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_-])`,
  ).test(text);

/**
 * Where to fix the failure, when the platform can tell from its words:
 * - setup naming a variable an MCP server of the experiment reads: Secrets;
 * - setup naming one of those MCP servers: the MCP servers tab;
 * - provider: Model access on the System page;
 * - worker_lost: the workers on the System page.
 * Anything else (timeout, other, an unrecognised setup error) has no link.
 */
export function failureFix(
  failure: ExperimentFailure,
  mcpServers: readonly McpSecretFacts[],
): ExperimentFailureView['fix'] {
  const text = `${failure.message}\n${failure.stderr_first_line ?? ''}`;
  switch (failure.category) {
    case 'setup': {
      if (mcpServers.some((s) => s.variables.some((v) => mentions(text, v)))) {
        return { label: 'check Secrets', to: '/resources/secrets' };
      }
      const server = mcpServers.find((s) => mentions(text, s.name));
      return server ? { label: `check MCP server ${server.name}`, to: '/resources/mcp' } : null;
    }
    case 'provider':
      return { label: 'check Model access', to: '/system' };
    case 'worker_lost':
      return { label: 'check Workers', to: '/system' };
    default:
      return null;
  }
}

export function failureView(
  failure: ExperimentFailure,
  errorRuns: readonly ErrorRunFacts[],
  mcpServers: readonly McpSecretFacts[],
): ExperimentFailureView {
  return {
    at: failure.at,
    threshold: failure.threshold,
    category: failure.category,
    message: failure.message,
    stderrFirstLine: failure.stderr_first_line,
    identicalIn: identicalIn(failure, errorRuns),
    fix: failureFix(failure, mcpServers),
    runId: failure.run_id,
  };
}

/** How the status reason names a provider. */
export const PROVIDER_NAMES: Record<Provider, string> = {
  nous: 'Nous Portal',
  'nous-api': 'The Nous API key',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  custom: 'The custom model endpoint',
};

const usd = (x: number): string => `$${x.toFixed(2)}`;

function pauseReasonText(
  reason: PauseReason,
  ceilingUsd: number | null,
  providers: readonly Provider[],
): string {
  switch (reason) {
    case 'user':
      return 'Paused by the user';
    case 'spend_ceiling':
      return ceilingUsd === null
        ? 'Paused at the spend ceiling'
        : `Paused at the ${usd(ceilingUsd)} spend ceiling`;
    case 'provider_disconnected': {
      const names = [...new Set(providers)].map((p) => PROVIDER_NAMES[p]);
      if (names.length === 1) return `Paused: ${names[0]} is not connected`;
      return `Paused: a model provider is not connected (${names.join(', ')})`;
    }
  }
}

export interface StatusReasonInput {
  status: ExperimentStatus;
  pauseReason: PauseReason | null;
  cancelledAt: Date | null;
  ceilingUsd: number | null;
  counts: RunCounts;
  totalRuns: number;
  /** Providers of the experiment's configurations, baseline first. */
  providers: readonly Provider[];
  failure: ExperimentFailureView | null;
}

/**
 * The list chip's tooltip:
 * - failed: "invoice-db failed to start (setup) in 14 of 14 runs", N runs
 *   ending identically of the runs in execution_error;
 * - paused: the pause reason;
 * - after Cancel: "Cancelling" while runs drain, then how many were cancelled;
 * - otherwise null.
 */
export function statusReason(input: StatusReasonInput): string | null {
  switch (input.status) {
    case 'failed': {
      const f = input.failure;
      if (f === null) return null;
      const runs = Math.max(input.counts.execution_error, f.identicalIn);
      return `${f.message} (${f.category}) in ${f.identicalIn} of ${runs} runs`;
    }
    case 'paused':
      return input.pauseReason === null
        ? null
        : pauseReasonText(input.pauseReason, input.ceilingUsd, input.providers);
    case 'completed': {
      if (input.cancelledAt === null) return null;
      const n = input.counts.cancelled;
      return n === 0 ? 'Cancelled' : `Cancelled: ${n} of ${input.totalRuns} runs cancelled`;
    }
    case 'running':
      return input.cancelledAt === null ? null : 'Cancelling: in-flight runs are finishing';
  }
}
