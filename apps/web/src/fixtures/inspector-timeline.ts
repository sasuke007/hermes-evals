/**
 * Timeline rows two inspector scenarios add to a run's timeline (scenarios.ts):
 *   hermes-background  Hermes's own requests to its known background hosts, recorded with
 *                      origin hermes_background (Phase 5 question 19): a refused CONNECT to
 *                      hermes-agent.nousresearch.com and an allowed one to
 *                      raw.githubusercontent.com, both neutral, tagged "Hermes background".
 *   mcp-http           a with-mcp run against the http sample vendor-directory (Phase 6):
 *                      its 405 to Hermes's GET for an event stream (a neutral "MCP event
 *                      stream not offered · vendor-directory · 405", question 15) and a
 *                      search_vendors result of 31,204 characters, cut at the MCP window
 *                      of 20,000 (question 13).
 * Rows go in after the timeline's first row; the rows after them are renumbered.
 */
import { TIMELINE_OUTPUT_LIMITS } from '@hermes-evals/shared';
import type { TimelineEvent, TimelineNetwork } from '@/api/types/runs';

type Active = (name: string) => boolean;
type RowPartial = Partial<TimelineEvent> &
  Pick<TimelineEvent, 'kind' | 'atMs' | 'title' | 'summary'>;

const BACKGROUND_TEXT =
  "Hermes's own background request, not the agent's action; it does not affect results.";

/** Characters search_vendors returned in the mcp-http scenario. */
export const LONG_MCP_OUTPUT_CHARS = 31_204;

function row(partial: RowPartial): Omit<TimelineEvent, 'seq'> {
  return {
    origin: 'agent',
    server: null,
    durationMs: null,
    error: false,
    running: false,
    input: null,
    output: null,
    outputChars: null,
    truncated: false,
    text: null,
    network: null,
    refusal: null,
    ...partial,
  };
}

function network(partial: Partial<TimelineNetwork> & Pick<TimelineNetwork, 'kind' | 'decision'>) {
  return {
    method: null,
    url: null,
    host: null,
    port: null,
    server: null,
    status: null,
    reason: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    forwardedTo: null,
    ...partial,
  };
}

function backgroundRows(): Omit<TimelineEvent, 'seq'>[] {
  const refused = 'hermes-agent.nousresearch.com';
  return [
    row({
      kind: 'refused',
      origin: 'hermes-background',
      atMs: 700,
      title: 'Refused by sandbox',
      summary: `${refused}:443`,
      text: `Refused by sandbox: ${refused}:443 (not on the allowlist). ${BACKGROUND_TEXT}`,
      network: network({
        kind: 'connect',
        decision: 'denied',
        host: refused,
        port: 443,
        reason: 'not on the allowlist',
      }),
      refusal: { host: refused, port: 443, reason: 'not on the allowlist' },
    }),
    row({
      kind: 'network',
      origin: 'hermes-background',
      atMs: 900,
      title: 'Connection',
      summary: 'raw.githubusercontent.com:443',
      durationMs: 240,
      text: `Connection to raw.githubusercontent.com:443 allowed by the sandbox. ${BACKGROUND_TEXT}`,
      network: network({
        kind: 'connect',
        decision: 'allowed',
        host: 'raw.githubusercontent.com',
        port: 443,
      }),
    }),
  ];
}

/** A result of `chars` characters: vendor rows, as many as fit. */
function vendorRows(chars: number): string {
  const rows: string[] = [];
  let length = 1;
  for (let i = 1; length < chars; i++) {
    const line = `{"vendor_id": "V-${String(i).padStart(4, '0')}", "name": "Vendor ${i}", "country": "NO", "payment_terms_days": 30},`;
    rows.push(line);
    length += line.length + 1;
  }
  return `[${rows.join('\n')}`.slice(0, chars);
}

function mcpHttpRows(atMs: number): Omit<TimelineEvent, 'seq'>[] {
  const host = 'vendor-directory';
  return [
    row({
      kind: 'network',
      atMs,
      // As the API titles it (Phase 6 question 15): neutral, not a failed MCP call.
      title: 'MCP event stream not offered',
      server: host,
      summary: `${host} · 405`,
      durationMs: 12,
      error: false,
      text: `${host} offers no event stream: it answered the MCP client's GET with 405, as the protocol allows. Its tools are called over POST, so the run is not affected.`,
      network: network({
        kind: 'mcp',
        decision: 'allowed',
        method: 'GET',
        url: `http://egress:8080/mcp/${host}`,
        host,
        port: 8000,
        server: host,
        status: 405,
      }),
    }),
    row({
      kind: 'tool',
      atMs: atMs + 400,
      title: 'search_vendors',
      server: host,
      summary: '{"country": "NO"}',
      durationMs: 820,
      input: '{"country": "NO"}',
      output: vendorRows(TIMELINE_OUTPUT_LIMITS.mcp),
      outputChars: LONG_MCP_OUTPUT_CHARS,
      truncated: true,
    }),
  ];
}

/** Puts `rows` after the timeline's first row and renumbers every row from 1. */
function insertAfterFirst(
  events: TimelineEvent[],
  rows: Omit<TimelineEvent, 'seq'>[],
): TimelineEvent[] {
  const [first, ...rest] = events;
  const all = first ? [first, ...rows, ...rest] : rows;
  return all.map((e, i) => ({ ...e, seq: i + 1 }));
}

/** The run's timeline with the rows the active scenarios add. */
export function withScenarioRows(
  active: Active,
  config: string,
  events: TimelineEvent[],
): TimelineEvent[] {
  let out = events;
  if (active('mcp-http') && config === 'with-mcp' && out.length) {
    out = insertAfterFirst(out, mcpHttpRows((out[0]?.atMs ?? 0) + 500));
  }
  if (active('hermes-background') && out.length) out = insertAfterFirst(out, backgroundRows());
  return out;
}
