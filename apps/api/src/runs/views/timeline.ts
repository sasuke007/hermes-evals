/**
 * The inspector's timeline (UI_FLOWS 18) from one attempt's run_events: a
 * row per event, except that a tool call's `tool_use` and `tool_result`
 * become one row with its input, output and duration, and a connection the
 * sandbox refused while a tool call ran is drawn on that call.
 *
 * Rows are ordered by when they happened (atMs, then seq). That is not seq
 * order: egress's connection log is stored when the attempt ends (plan 8.3),
 * so its rows carry late seq numbers but early times.
 *
 * Paging (GET /runs/:id/events?after=): every row keeps the highest seq of
 * the events it was built from. A page returns the rows built from any event
 * after `after`, so a tool row whose result, or a refusal on it, arrived
 * since the last poll comes again, with the seq of its tool_use; the client
 * replaces rows by seq. A page is built from the events after `after` and
 * the earlier tool events those rows join (run-views.service.ts), not from
 * the whole attempt, so an inspector polling every second reads only what
 * is new.
 */
import type { TimelineEvent } from '@hermes-evals/shared';
import { parseMcpToolName } from '../../execution/stream-json.js';
import { platformRow } from './platform-rows.js';
import type { EventRecord } from './rows.js';
import {
  blankRow,
  clip,
  networkRow,
  resultRow,
  str,
  systemRow,
  textRow,
  type NetworkContext,
  type Payload,
  type Refusal,
} from './timeline-rows.js';

/** Hermes cuts every tool output at this many characters and appends "...". */
export const TOOL_OUTPUT_LIMIT = 5_000;

export interface TimelineContext extends NetworkContext {
  /** Epoch ms the attempt started; atMs counts from here. */
  startedAtMs: number;
  /** The attempt's MCP server names, to tag `mcp__<server>__<tool>` calls with their server. */
  mcpServers: readonly string[];
}

/** A row and the highest seq it was built from (for paging). */
export interface TimelineRow {
  event: TimelineEvent;
  maxSeq: number;
}

/** A tool row being built, with the window during which the tool ran. */
interface ToolCall {
  row: TimelineRow;
  callId: string | null;
  name: string;
  startTs: number;
  endTs: number | null;
}

/** The tool call's input in one line: its command, path or query, else its JSON. */
function inputSummary(input: unknown): string {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const fields = input as Payload;
    for (const key of ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'code']) {
      const value = str(fields, key);
      if (value?.trim()) return clip(value.trim().split('\n')[0] ?? '');
    }
  }
  return input === undefined ? '' : clip(JSON.stringify(input));
}

const outputText = (output: unknown): string | null =>
  output === undefined || output === null
    ? null
    : typeof output === 'string'
      ? output
      : JSON.stringify(output);

/** The open tool_use a tool_result answers: by tool_call_id, else the oldest open one of that name. */
function takeOpenCall(open: ToolCall[], callId: string | null, name: string): ToolCall | null {
  const index = callId
    ? open.findIndex((c) => c.callId === callId)
    : open.findIndex((c) => c.callId === null && c.name === name);
  if (index < 0) return null;
  const [call] = open.splice(index, 1);
  return call ?? null;
}

export function buildTimeline(events: readonly EventRecord[], ctx: TimelineContext): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const calls: ToolCall[] = [];
  const open: ToolCall[] = [];
  const refusals: Refusal[] = [];
  const at = (ts: number) => Math.max(0, Math.round(ts - ctx.startedAtMs));
  const push = (event: TimelineEvent, seq: number) => {
    const row = { event, maxSeq: seq };
    rows.push(row);
    return row;
  };

  for (const { seq, ts, type, payload } of events) {
    const p = payload as Payload;
    switch (type) {
      case 'tool_use': {
        const call = toolCall(seq, at(ts), ts, p, ctx);
        rows.push(call.row);
        calls.push(call);
        open.push(call);
        break;
      }
      case 'tool_result': {
        const name = str(p, 'name') ?? 'tool';
        const call =
          takeOpenCall(open, str(p, 'tool_call_id') ?? null, name) ??
          // A result whose call was never seen: a row of its own.
          (() => {
            const orphan = toolCall(seq, at(ts), ts, { name }, ctx);
            rows.push(orphan.row);
            calls.push(orphan);
            return orphan;
          })();
        completeCall(call, seq, ts, p);
        break;
      }
      case 'text':
        push(textRow(seq, at(ts), p), seq);
        break;
      case 'result':
        push(resultRow(seq, at(ts), p), seq);
        break;
      case 'system':
        push(systemRow(seq, at(ts), p), seq);
        break;
      case 'platform': {
        if (str(p, 'subtype') !== 'network') {
          push(platformRow(seq, at(ts), p), seq);
          break;
        }
        const row = networkRow(seq, at(ts), ts, p, ctx);
        if ('kind' in row) push(row, seq);
        else refusals.push(row);
        break;
      }
    }
  }

  for (const refusal of refusals) {
    const call = callAt(calls, refusal.ts);
    if (call) {
      call.row.event.refusal = { host: refusal.host, port: refusal.port, reason: refusal.reason };
      call.row.maxSeq = Math.max(call.row.maxSeq, refusal.seq);
    } else {
      push(refusalRow(refusal), refusal.seq);
    }
  }

  return rows.sort((a, b) => a.event.atMs - b.event.atMs || a.event.seq - b.event.seq);
}

function toolCall(
  seq: number,
  atMs: number,
  ts: number,
  p: Payload,
  ctx: TimelineContext,
): ToolCall {
  const name = str(p, 'name') ?? 'tool';
  const mcp = parseMcpToolName(name, ctx.mcpServers.length > 0 ? ctx.mcpServers : undefined);
  const input = p['input'];
  const event: TimelineEvent = {
    ...blankRow(seq, atMs, 'tool', mcp?.tool ?? name, inputSummary(input)),
    server: mcp?.server ?? null,
    running: true,
    input: input === undefined ? null : JSON.stringify(input),
  };
  return {
    row: { event, maxSeq: seq },
    callId: str(p, 'tool_call_id') ?? null,
    name,
    startTs: ts,
    endTs: null,
  };
}

function completeCall(call: ToolCall, seq: number, ts: number, p: Payload): void {
  const output = outputText(p['output']);
  const reported = p['duration_ms'];
  const event = call.row.event;
  event.running = false;
  event.output = output;
  event.outputChars = output?.length ?? null;
  event.truncated = (output?.length ?? 0) > TOOL_OUTPUT_LIMIT;
  event.error = p['is_error'] === true;
  event.durationMs =
    typeof reported === 'number' && Number.isSafeInteger(reported) && reported >= 0
      ? reported
      : Math.max(0, Math.round(ts - call.startTs));
  call.endTs = ts;
  call.row.maxSeq = Math.max(call.row.maxSeq, seq);
}

/** The tool call that was running at `ts` and has no refusal yet; the latest one started wins. */
function callAt(calls: readonly ToolCall[], ts: number): ToolCall | null {
  let best: ToolCall | null = null;
  for (const call of calls) {
    if (call.row.event.refusal !== null) continue;
    if (call.startTs > ts || (call.endTs !== null && call.endTs < ts)) continue;
    if (!best || call.startTs >= best.startTs) best = call;
  }
  return best;
}

/** A refused connection no tool call was running for: a row of its own. */
function refusalRow(r: Refusal): TimelineEvent {
  const target = `${r.host}:${r.port}`;
  return {
    ...blankRow(r.seq, r.atMs, 'refused', 'Refused by sandbox', target),
    error: true,
    text: `Refused by sandbox: ${target} (${r.reason}).`,
    network: r.network,
    refusal: { host: r.host, port: r.port, reason: r.reason },
  };
}

/** GET /runs/:id/events?after=: the rows touched by events after `after`, and the next cursor. */
export function timelinePage(
  rows: readonly TimelineRow[],
  after: number,
  lastEventSeq: number,
): { events: TimelineEvent[]; lastSeq: number } {
  return {
    events: rows.filter((r) => r.maxSeq > after).map((r) => r.event),
    lastSeq: Math.max(after, lastEventSeq),
  };
}

/**
 * The agent's turn so far, from its events: Hermes calls the model once per
 * turn, and each call answers with text or tool calls, so a turn starts at
 * the first text or tool_use after the previous turn's tool results. An
 * estimate for the live header ("turn 6 of 20"); Hermes emits no turn event.
 */
export function turnsSoFar(events: readonly Pick<EventRecord, 'type'>[]): number {
  let turns = 0;
  let inTurn = false;
  for (const { type } of events) {
    if (type === 'text' || type === 'tool_use') {
      if (!inTurn) turns++;
      inTurn = true;
    } else if (type === 'tool_result') {
      inTurn = false;
    }
  }
  return turns;
}
