/**
 * One timeline row per stored event that stands on its own: the agent's
 * streamed text, Hermes's `result`, Hermes's `system` init, and the entries
 * of egress's connection log (`platform` events with subtype `network`,
 * UI_FLOWS 19 #6). The worker's other platform events are drawn in
 * platform-rows.ts; tool calls pair two events and are built in timeline.ts.
 *
 * Every payload was written from untrusted output (stdout lines, the agent's
 * tool calls) or by the worker, so each field is read defensively: a missing
 * or mistyped field leaves the row's detail empty, never throws.
 */
import {
  NETWORK_EVENT_KINDS,
  NETWORK_ORIGINS,
  TIMELINE_ORIGIN_OF,
  type NetworkEventKind,
  type TimelineEvent,
  type TimelineNetwork,
  type TimelineOrigin,
} from '@hermes-evals/shared';
import { MODEL_GATEWAY_BASE_URL } from '../../execution/providers-map.js';
import { egressMcpUrl } from '../../resources/mcp/hermes-config.js';

/** Characters of a row's one-line summary. */
export const SUMMARY_MAX_CHARS = 160;

export type Payload = Readonly<Record<string, unknown>>;

export const str = (p: Payload, key: string): string | undefined => {
  const v = p[key];
  return typeof v === 'string' ? v : undefined;
};

export const int = (p: Payload, key: string): number | undefined => {
  const v = p[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
};

export const count = (p: Payload, key: string): number | undefined => {
  const v = int(p, key);
  return v !== undefined && v >= 0 ? v : undefined;
};

/** Cuts a line to `max` characters with an ellipsis. */
export function clip(text: string, max = SUMMARY_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The first line with any text on it, clipped: how a long text reads in one row. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return clip(line.trim());
}

/** A row with every optional detail empty; callers set what their event carries. */
export function blankRow(
  seq: number,
  atMs: number,
  kind: TimelineEvent['kind'],
  title: string,
  summary: string,
): TimelineEvent {
  return {
    seq,
    kind,
    origin: 'agent',
    atMs,
    title,
    server: null,
    summary,
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
  };
}

/** A `text` event: what the agent streamed while it worked. */
export function textRow(seq: number, atMs: number, p: Payload): TimelineEvent {
  const text = str(p, 'text') ?? '';
  return { ...blankRow(seq, atMs, 'text', 'text', firstLine(text)), text };
}

/**
 * Hermes's `result`: the final response, or how the run failed (a provider
 * failure still ends in a result, with `error` set and Hermes's message as
 * its text). A result the worker recorded itself, when the deadline stopped
 * a run that never sent one (plan 8.4), carries `synthesized: true`.
 */
export function resultRow(seq: number, atMs: number, p: Payload): TimelineEvent {
  const text = str(p, 'text') ?? null;
  const error = str(p, 'error');
  const synthesized = p['synthesized'] === true;
  const summary = error
    ? clip(`error: ${error}`)
    : text && text.trim()
      ? firstLine(text)
      : 'empty response';
  return {
    ...blankRow(
      seq,
      atMs,
      'final',
      synthesized ? 'result (recorded by the worker)' : 'final response',
      summary,
    ),
    durationMs: count(p, 'duration_ms') ?? null,
    error: Boolean(error),
    text,
  };
}

/** Hermes's `system` init: the run started on this model. */
export function systemRow(seq: number, atMs: number, p: Payload): TimelineEvent {
  const model = str(p, 'model');
  const subtype = str(p, 'subtype') ?? 'system';
  return blankRow(
    seq,
    atMs,
    'platform',
    subtype,
    model ? `Hermes started · model ${model}` : 'Hermes started',
  );
}

// ---------------------------------------------------------------------------
// Egress's connection log
// ---------------------------------------------------------------------------

/** A connection egress refused, before it is placed (a tool call's sub-row, or its own row). */
export interface Refusal {
  seq: number;
  atMs: number;
  /** Epoch ms of the refusal, to find the tool call it happened during. */
  ts: number;
  host: string;
  port: number;
  reason: string;
  /** The log entry, for the row of its own a refusal outside any tool call gets. */
  network: TimelineNetwork;
}

const BACKGROUND_TEXT =
  "Hermes's own background request, not the agent's action; it does not affect results.";

/** Where the attempt's model calls went, by the configuration's provider. */
export interface NetworkContext {
  /** Display name of the upstream, e.g. `Nous Portal`; null when unknown. */
  forwardedTo: string | null;
}

/**
 * Whose a network row is (Phase 7): the stored `origin`, else, on an event
 * stored before it, the `background` flag the worker set then.
 */
export function networkOriginOf(p: Payload): TimelineOrigin {
  const stored = NETWORK_ORIGINS.find((o) => o === p['origin']);
  if (stored) return TIMELINE_ORIGIN_OF[stored];
  return p['background'] === true ? 'hermes-background' : 'agent';
}

/**
 * Hermes's MCP client opens the server's event stream with a GET, and a
 * streamable-HTTP server that offers none answers 405, as the protocol
 * allows (vendor-directory does; Phase 6 question 15). Drawn as a neutral
 * row, not a failed call: every request of the run still goes over POST.
 */
export function isEventStreamDeclined(p: Payload): boolean {
  return (
    str(p, 'kind') === 'mcp' &&
    str(p, 'decision') !== 'denied' &&
    str(p, 'method') === 'GET' &&
    int(p, 'status') === 405
  );
}

/** The log entry's kind; an unknown one reads as a connection, as its row does. */
function networkKind(p: Payload): NetworkEventKind {
  const kind = str(p, 'kind');
  return NETWORK_EVENT_KINDS.find((k) => k === kind) ?? 'connect';
}

/**
 * One stored `network` platform event as the row's structured `network`
 * field (TimelineNetwork, Phase 2 question 4), for every kind egress logs:
 * a model call, an MCP gateway call, a CONNECT or a plain-HTTP request,
 * allowed or refused. What the log does not record for that kind is null:
 * the URL is the gateway route the trial called (model, MCP), and a CONNECT
 * or plain-HTTP request has only its host and port.
 */
export function networkEntry(p: Payload, ctx: NetworkContext): TimelineNetwork {
  const kind = networkKind(p);
  const decision = str(p, 'decision') === 'denied' ? 'denied' : 'allowed';
  const port = int(p, 'port');
  const status = int(p, 'status');
  const server = kind === 'mcp' ? (str(p, 'server') ?? null) : null;
  const model = kind === 'model';
  return {
    kind,
    decision,
    // A model call is a POST to the chat route; egress logs an MCP call's method.
    method: kind === 'connect' ? null : (str(p, 'method') ?? (model ? 'POST' : null)),
    url: model
      ? `${MODEL_GATEWAY_BASE_URL}${str(p, 'path') ?? '/chat/completions'}`
      : server !== null
        ? egressMcpUrl(server)
        : null,
    host: str(p, 'host') ?? null,
    port: port !== undefined && port >= 1 && port <= 65_535 ? port : null,
    server,
    status: status !== undefined && status >= 100 && status <= 599 ? status : null,
    reason: str(p, 'reason') ?? null,
    model: model ? (str(p, 'model') ?? null) : null,
    tokensIn: model ? (count(p, 'tokens_in') ?? null) : null,
    tokensOut: model ? (count(p, 'tokens_out') ?? null) : null,
    // A refused model call never left egress.
    forwardedTo: model && decision === 'allowed' ? ctx.forwardedTo : null,
  };
}

/**
 * A `network` platform event as a row, or as a Refusal when it is a
 * connection the agent's own tools attempted and egress refused: those are
 * drawn on the tool call that made them when one was running at the time
 * (timeline.ts). `atMs` is when the connection or call started (egress logs
 * an entry when it ends, so the duration is taken off).
 */
export function networkRow(
  seq: number,
  atMs: number,
  ts: number,
  p: Payload,
  ctx: NetworkContext,
): TimelineEvent | Refusal {
  const network = networkEntry(p, ctx);
  const kind = str(p, 'kind');
  const denied = network.decision === 'denied';
  const origin = networkOriginOf(p);
  const background = origin === 'hermes-background';
  const ms = count(p, 'ms') ?? null;
  const status = int(p, 'status');
  const reason = str(p, 'reason');
  const host = str(p, 'host');
  const port = int(p, 'port');
  const start = Math.max(0, atMs - (ms ?? 0));
  const target = host ? (port ? `${host}:${port}` : host) : 'unknown host';
  const hasTarget = host !== undefined && port !== undefined && port >= 1 && port <= 65_535;

  if ((kind === 'connect' || kind === 'http') && denied) {
    if (!background && hasTarget) {
      return { seq, atMs, ts, host, port, reason: reason ?? 'refused by the sandbox', network };
    }
    return {
      ...blankRow(seq, atMs, 'refused', 'Refused by sandbox', target),
      origin,
      error: !background,
      text: `Refused by sandbox: ${target}${reason ? ` (${reason})` : ''}.${background ? ` ${BACKGROUND_TEXT}` : ''}`,
      network,
      refusal: hasTarget ? { host, port, reason: reason ?? 'refused by the sandbox' } : null,
    };
  }

  if (kind === 'model') {
    return { ...modelCallRow(seq, start, p, ctx, { denied, origin, ms, status, reason }), network };
  }

  if (kind === 'mcp') {
    const server = str(p, 'server') ?? null;
    const name = server ?? 'MCP server';
    if (isEventStreamDeclined(p)) {
      return {
        ...blankRow(seq, start, 'network', 'MCP event stream not offered', `${name} · 405`),
        origin,
        server,
        durationMs: ms,
        text:
          `${name} offers no event stream: it answered the MCP client's GET with 405, as ` +
          'the protocol allows. Its tools are called over POST, so the run is not affected.',
        network,
      };
    }
    const outcome = denied
      ? `refused: ${reason ?? 'refused by the MCP gateway'}`
      : (status ?? 'no answer');
    return {
      ...blankRow(seq, start, 'network', 'MCP call', `${name} · ${outcome}`),
      origin,
      server,
      durationMs: ms,
      error: denied || status === undefined || status >= 400,
      text: `${name} through the MCP gateway (${host ?? 'its URL'}) → ${outcome}${reason && !denied ? ` (${reason})` : ''}.`,
      network,
    };
  }

  const title = kind === 'http' ? 'HTTP request' : 'Connection';
  return {
    ...blankRow(seq, start, 'network', title, status ? `${target} · ${status}` : target),
    origin,
    durationMs: ms,
    error: !background && status !== undefined && status >= 400,
    text: `${title} to ${target} allowed by the sandbox${status ? ` → ${status}` : ''}.${background ? ` ${BACKGROUND_TEXT}` : ''}`,
    network,
  };
}

/**
 * One call through the model gateway: drawn with its tokens when egress
 * counted them. Its `network` field is set by networkRow, as on every row
 * from the connection log.
 */
function modelCallRow(
  seq: number,
  atMs: number,
  p: Payload,
  ctx: NetworkContext,
  call: {
    denied: boolean;
    origin: TimelineEvent['origin'];
    ms: number | null;
    status: number | undefined;
    reason: string | undefined;
  },
): TimelineEvent {
  const model = str(p, 'model');
  const name = model ?? 'model';
  if (call.denied) {
    const why = call.reason ?? 'refused by the model gateway';
    return {
      ...blankRow(seq, atMs, 'network', 'Model call refused', `${name} · ${why}`),
      origin: call.origin,
      error: true,
      text: `The model gateway refused a call to ${name}: ${why}.`,
    };
  }
  const method = str(p, 'method') ?? 'POST';
  const url = `${MODEL_GATEWAY_BASE_URL}${str(p, 'path') ?? '/chat/completions'}`;
  const tokensIn = count(p, 'tokens_in');
  const tokensOut = count(p, 'tokens_out');
  const status = call.status;
  const answered = status !== undefined && status >= 100 && status <= 599;
  const tokens =
    tokensIn !== undefined && tokensOut !== undefined
      ? ` · ${(tokensIn + tokensOut).toLocaleString('en-US')} tokens (${tokensIn.toLocaleString('en-US')} in / ${tokensOut.toLocaleString('en-US')} out)`
      : '';
  const forwarded = ctx.forwardedTo ? `, forwarded to ${ctx.forwardedTo}` : '';
  return {
    ...blankRow(seq, atMs, 'network', 'Model call', `${name} · ${status ?? 'no answer'}${tokens}`),
    origin: call.origin,
    durationMs: call.ms,
    error: !answered || status >= 400,
    text: `${method} ${url} → ${status ?? 'no answer'}${forwarded}.${call.reason ? ` ${call.reason}` : ''}`,
  };
}
