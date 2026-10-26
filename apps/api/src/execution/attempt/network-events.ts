/**
 * Egress's connection log for an attempt, as `network` platform events
 * (plan 8.3, UI_FLOWS 19 #6): every CONNECT the trial tried, allowed or
 * refused, every plain-HTTP request through the proxy, and every model and
 * MCP gateway call.
 *
 * Each event says whose it was (`origin`, Phase 7): egress labels a CONNECT
 * or plain-HTTP request to one of Hermes's own background hosts
 * (HERMES_BACKGROUND_HOSTS: the credits-seed pricing fetch every `nous` run
 * makes, plan 8.2, and the two hosts Phase 5 saw refused) `hermes_background`,
 * so the inspector draws it neutral rather than as the agent's action. An
 * entry egress did not label (an egress from before Phase 7, or a client
 * that dropped the field) is labelled here by the same host list. The gateways'
 * calls are the agent's. `background` stays, true exactly for
 * `hermes_background`, for readers of events stored before the origin.
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
  isHermesBackgroundHost,
  NETWORK_ORIGINS,
  NetworkEventPayloadSchema,
  type NetworkEventPayload,
  type NetworkOrigin,
} from '@hermes-evals/shared';
import type { EgressLogEntry } from '../../sandbox/egress-client.js';
import type { AttemptEventInput } from '../contracts.js';

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

/**
 * Fields egress may log beyond EgressLogEntry's: an MCP call's method, a
 * model call's tokens, a proxy entry's origin.
 */
type LoggedEntry = EgressLogEntry & {
  method?: unknown;
  promptTokens?: unknown;
  completionTokens?: unknown;
  origin?: unknown;
};

const HTTP_METHOD = /^[A-Z]{1,16}$/;

/**
 * Whose the entry was: egress's label when it gave a known one, else by
 * host for the forward proxy's entries (`connect`, `http`); the model and
 * MCP gateways' calls are the agent's.
 */
export function networkOrigin(entry: LoggedEntry): NetworkOrigin {
  if (entry.kind !== 'connect' && entry.kind !== 'http') return 'agent';
  const labelled = NETWORK_ORIGINS.find((origin) => origin === entry.origin);
  if (labelled) return labelled;
  return entry.host !== undefined && isHermesBackgroundHost(entry.host.replace(/\.$/, ''))
    ? 'hermes_background'
    : 'agent';
}

/** One log entry as its event payload; fields egress did not report are left out. */
export function networkPayload(entry: LoggedEntry): NetworkEventPayload {
  const port = count(entry.port);
  const status = count(entry.status);
  const ms = count(entry.ms);
  const tokensIn = count(entry.promptTokens);
  const tokensOut = count(entry.completionTokens);
  const method =
    typeof entry.method === 'string' && HTTP_METHOD.test(entry.method) ? entry.method : undefined;
  const origin = networkOrigin(entry);
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
    origin,
    background: origin === 'hermes_background',
  };
}

/**
 * The attempt's connection log as events, in log order. An entry that does
 * not fit the network payload (an egress that logs something new) is kept
 * as `unmapped`, never dropped.
 */
export function networkEvents(
  log: readonly EgressLogEntry[],
  now = Date.now(),
): AttemptEventInput[] {
  return log.map((entry) => {
    const at = Date.parse(entry.at);
    const ts = Number.isFinite(at) && at > 0 ? at : now;
    const checked = NetworkEventPayloadSchema.safeParse(networkPayload(entry));
    return checked.success
      ? { ts, type: 'platform', payload: checked.data }
      : {
          ts,
          type: 'platform',
          payload: { type: 'platform', subtype: 'unmapped', source: 'egress', event: { ...entry } },
        };
  });
}
