/**
 * Hermes's own background requests (Phase 5 question 19, Phase 7): hosts
 * Hermes contacts by itself rather than for the agent, as the platform has
 * seen them. Every `nous` run makes the credits-seed pricing fetch to
 * inference-api.nousresearch.com (plan 8.2, spike I10), and Phase 5 saw
 * requests to hermes-agent.nousresearch.com and raw.githubusercontent.com
 * refused. Egress labels a CONNECT or plain-HTTP request to one of them with
 * origin `hermes_background` in its connection log, so the run inspector
 * draws the row neutral rather than as the agent's refused connection.
 *
 * The label is by host alone: a request the agent itself makes to one of
 * these hosts is labelled the same way. The decision does not change: in
 * allowlist mode the request is still refused.
 *
 * The same list as HERMES_BACKGROUND_HOSTS in packages/shared runtime.ts;
 * egress does not depend on that package, so it keeps its own copy, and
 * apps/api's network-events spec checks the two agree.
 */

/** Lower case, no port. */
export const HERMES_BACKGROUND_HOSTS: readonly string[] = [
  'inference-api.nousresearch.com',
  'hermes-agent.nousresearch.com',
  'raw.githubusercontent.com',
];

/** Who a connection log entry was for (NETWORK_ORIGINS in packages/shared vocab.ts). */
export type NetworkOrigin = 'agent' | 'hermes_background';

/** Whether `host` (any case, an optional trailing dot, no port) is one of HERMES_BACKGROUND_HOSTS. */
export function isHermesBackgroundHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  return HERMES_BACKGROUND_HOSTS.includes(name);
}

/** A forward-proxy entry's origin: `hermes_background` for a background host, else `agent`. */
export const originOf = (host: string | undefined): NetworkOrigin =>
  isHermesBackgroundHost(host) ? 'hermes_background' : 'agent';
