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
import type { TimelineEvent } from '@hermes-evals/shared';
import { MODEL_GATEWAY_BASE_URL } from '../../execution/providers-map.js';

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
}

const BACKGROUND_TEXT =
  "Hermes's own background request, not the agent's action; it does not affect results.";

/** Where the attempt's model calls went, by the configuration's provider. */
export interface NetworkContext {
  /** Display name of the upstream, e.g. `Nous Portal`; null when unknown. */
  forwardedTo: string | null;
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
  const kind = str(p, 'kind');
  const denied = str(p, 'decision') === 'denied';
  const background = p['background'] === true;
  const ms = count(p, 'ms') ?? null;
  const status = int(p, 'status');
  const reason = str(p, 'reason');
  const host = str(p, 'host');
  const port = int(p, 'port');
  const start = Math.max(0, atMs - (ms ?? 0));
  const origin = background ? ('hermes-background' as const) : ('agent' as const);
  const target = host ? (port ? `${host}:${port}` : host) : 'unknown host';
  const hasTarget = host !== undefined && port !== undefined && port >= 1 && port <= 65_535;

  if ((kind === 'connect' || kind === 'http') && denied) {
    if (!background && hasTarget) {
      return { seq, atMs, ts, host, port, reason: reason ?? 'refused by the sandbox' };
    }
    return {
      ...blankRow(seq, atMs, 'refused', 'Refused by sandbox', target),
      origin,
      error: !background,
      text: `Refused by sandbox: ${target}${reason ? ` (${reason})` : ''}.${background ? ` ${BACKGROUND_TEXT}` : ''}`,
      refusal: hasTarget ? { host, port, reason: reason ?? 'refused by the sandbox' } : null,
    };
  }

  if (kind === 'model')
    return modelCallRow(seq, start, p, ctx, { denied, origin, ms, status, reason });

  if (kind === 'mcp') {
    const server = str(p, 'server') ?? null;
    const name = server ?? 'MCP server';
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
    };
  }

  const title = kind === 'http' ? 'HTTP request' : 'Connection';
  return {
    ...blankRow(seq, start, 'network', title, status ? `${target} · ${status}` : target),
    origin,
    durationMs: ms,
    error: status !== undefined && status >= 400,
    text: `${title} to ${target} allowed by the sandbox${status ? ` → ${status}` : ''}.${background ? ` ${BACKGROUND_TEXT}` : ''}`,
  };
}

/** One call through the model gateway: drawn with its tokens when egress counted them. */
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
    network:
      answered && model !== undefined && tokensIn !== undefined && tokensOut !== undefined
        ? { method, url, status, model, tokensIn, tokensOut, forwardedTo: ctx.forwardedTo }
        : null,
  };
}
