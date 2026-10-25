/**
 * Egress's connection log for an attempt, as `network` platform events
 * (plan 8.3, UI_FLOWS 19 #6): every CONNECT the trial tried, allowed or
 * refused, every plain-HTTP request through the proxy, and every model and
 * MCP gateway call. Hermes's own background call on its route (the
 * credits-seed fetch every `nous` run makes, plan 8.2) is marked
 * `background: true`, so the inspector labels it as Hermes baseline traffic
 * rather than an agent action.
 *
 * Egress logs hosts and outcomes, never headers or bodies, but the agent
 * chooses the host names it tries, so the runner redacts these events too.
 *
 * Beyond the E8 fields the payload keeps what the inspector draws when
 * egress reports it: the HTTP `method` of an MCP gateway call, and a model
 * call's own token counts as `tokens_in` and `tokens_out` (egress logs
 * those as `promptTokens` and `completionTokens`, in EgressUsage's names).
 */
import {
  NetworkEventPayloadSchema,
  type NetworkEventPayload,
  type Provider,
} from '@hermes-evals/shared';
import type { EgressLogEntry } from '../../sandbox/egress-client.js';
import type { AttemptEventInput } from '../contracts.js';
import { isBackgroundHost } from '../providers-map.js';

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/** Fields egress may log beyond EgressLogEntry's: an MCP call's method, a model call's tokens. */
type LoggedEntry = EgressLogEntry & {
  method?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
};

const HTTP_METHOD = /^[A-Z]{1,16}$/;

/** One log entry as its event payload; fields egress did not report are left out. */
export function networkPayload(entry: LoggedEntry, provider: Provider): NetworkEventPayload {
  const port = count(entry.port);
  const status = count(entry.status);
  const ms = count(entry.ms);
  const tokensIn = count(entry.promptTokens);
  const tokensOut = count(entry.completionTokens);
  const method =
    typeof entry.method === 'string' && HTTP_METHOD.test(entry.method) ? entry.method : undefined;
  return {
    type: 'platform',
    subtype: 'network',
    kind: entry.kind,
    ...(entry.host !== undefined ? { host: entry.host } : {}),
    ...(port !== undefined && port <= 65_535 ? { port } : {}),
    decision: entry.decision,
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(ms !== undefined ? { ms } : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.server !== undefined ? { server: entry.server } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(tokensIn !== undefined && tokensOut !== undefined
      ? { tokens_in: tokensIn, tokens_out: tokensOut }
      : {}),
    background: isBackgroundHost(provider, entry.host),
  };
}

/**
 * The attempt's connection log as events, in log order. An entry that does
 * not fit the network payload (an egress that logs something new) is kept
 * as `unmapped`, never dropped.
 */
export function networkEvents(
  log: readonly EgressLogEntry[],
  provider: Provider,
  now = Date.now(),
): AttemptEventInput[] {
  return log.map((entry) => {
    const at = Date.parse(entry.at);
    const ts = Number.isFinite(at) && at > 0 ? at : now;
    const checked = NetworkEventPayloadSchema.safeParse(networkPayload(entry, provider));
    return checked.success
      ? { ts, type: 'platform', payload: checked.data }
      : {
          ts,
          type: 'platform',
          payload: { type: 'platform', subtype: 'unmapped', source: 'egress', event: { ...entry } },
        };
  });
}
