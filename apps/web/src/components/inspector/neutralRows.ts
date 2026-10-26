/**
 * Timeline rows the run inspector draws neutral although the API may flag them (Phase 7):
 * Hermes's own background requests (Phase 5 question 19) and an http MCP server's 405 to
 * the event-stream GET (Phase 6 question 15). Pure, so the row and its tests share them.
 */
import type { TimelineEvent } from '@/api/types/runs';

/**
 * An http MCP server's 405 to Hermes's GET for an event stream (Phase 6 question 15): the
 * server offers none, which the protocol allows, so the row is neutral, not an error. The
 * API titles it so and clears its error flag; the page draws it neutral either way.
 */
export function isMcpStreamNotOffered(event: TimelineEvent): boolean {
  const n = event.network;
  return (
    event.kind === 'network' &&
    n?.kind === 'mcp' &&
    n.decision === 'allowed' &&
    n.method === 'GET' &&
    n.status === 405
  );
}

/** That row's title, as the API writes it; its summary is "vendor-directory · 405". */
export const MCP_STREAM_NOT_OFFERED = 'MCP event stream not offered';

/**
 * A row drawn neutral although it may carry an error flag: Hermes's own background request
 * (Phase 5 question 19) or an MCP server's 405 to the event-stream GET.
 */
export function isNeutralRow(event: TimelineEvent): boolean {
  return event.origin === 'hermes-background' || isMcpStreamNotOffered(event);
}

/** The title a row shows: the API's, or "MCP event stream not offered" for a 405 stream row. */
export function rowTitle(event: TimelineEvent): string {
  return isMcpStreamNotOffered(event) ? MCP_STREAM_NOT_OFFERED : event.title;
}
