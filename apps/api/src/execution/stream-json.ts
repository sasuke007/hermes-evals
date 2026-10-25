/**
 * Hermes's `hermes chat --oneshot --format stream-json` output, one JSON
 * object per stdout line (hermes_cli/stream_json.py StreamJsonEmitter at
 * revision 4d04303):
 *
 *   {"type":"system","subtype":"init","model":…,"session_id":"","timestamp":…}
 *   {"type":"text","text":…,"timestamp":…}
 *   {"type":"tool_use","name":…,"tool_call_id":…,"input":{…},"timestamp":…}
 *   {"type":"tool_result","name":…,"tool_call_id":…,"output":…,"duration_ms":…,"is_error":…,"timestamp":…}
 *   {"type":"result","session_id":…,"exit_code":…,"text":…,"tokens":{…},"duration_ms":…,"error"?:…,"replay_gap"?:true,"timestamp":…}
 *
 * `timestamp` is epoch milliseconds. Tool output is cut at 5,000 characters
 * with "..." appended. The session id is empty in `init` and set in `result`.
 *
 * Observed with the real Hermes in the trial image (network none, a scripted
 * model inside the container, no login; the spec holds the recorded lines):
 * - The `result` text is the answer. Streamed `text` deltas differ from it
 *   (here a leading "\n\n"), so they are for display only (plan 8.3).
 * - A provider failure still ends in a `result`: exit_code 1, `error` set
 *   (e.g. "Connection error."), tokens all 0, and `text` holding Hermes's
 *   human message, not an answer. Classify on `error` before `text`.
 * - A call to a tool that does not exist produces no tool_use or
 *   tool_result event; the model only gets an error message back.
 *
 * Every line is untrusted. stdout belongs to the `hermes chat` client, and any
 * process the agent starts runs as the same uid in the same container and can
 * write to it. So only the five Hermes types map to events; anything else,
 * including a line that claims to be a `platform` event, is stored as the
 * worker's own `unmapped` or `noise` event. Hermes writes exactly one
 * `result`, as its last line before the client exits.
 */
import { createHash } from 'node:crypto';
import {
  RunEventPayloadSchema,
  TokensSchema,
  type RunEventPayload,
  type Tokens,
} from '@hermes-evals/shared';
import type { AttemptEventInput } from './contracts.js';

/** Characters of a non-JSON stdout line kept in its `noise` event. */
export const NOISE_LINE_MAX_CHARS = 8_000;

/** The event types Hermes emits; `platform` is the worker's own and never comes from stdout. */
const HERMES_EVENT_TYPES = new Set(['system', 'text', 'tool_use', 'tool_result', 'result']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The event's own epoch-ms timestamp when it is a usable one, else the time the worker read it. */
function eventTime(value: unknown, receivedAt: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : receivedAt;
}

/**
 * Maps one stdout line to the event the worker stores (plan 8.3). Never
 * throws: a line that is not a JSON object becomes `platform`/`noise`, and an
 * object of an unknown type, or a Hermes type without its required fields,
 * becomes `platform`/`unmapped` with the object kept under `event`.
 */
export function parseStreamLine(line: string, receivedAt: number): AttemptEventInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    const truncated = line.length > NOISE_LINE_MAX_CHARS;
    const payload: RunEventPayload = {
      type: 'platform',
      subtype: 'noise',
      line: truncated ? line.slice(0, NOISE_LINE_MAX_CHARS) : line,
      ...(truncated ? { truncated: true, chars: line.length } : {}),
    };
    return { ts: receivedAt, type: 'platform', payload };
  }
  const ts = eventTime(parsed.timestamp, receivedAt);
  if (typeof parsed.type === 'string' && HERMES_EVENT_TYPES.has(parsed.type)) {
    const checked = RunEventPayloadSchema.safeParse(parsed);
    if (checked.success) return { ts, type: checked.data.type, payload: checked.data };
  }
  return {
    ts,
    type: 'platform',
    payload: { type: 'platform', subtype: 'unmapped', event: parsed },
  };
}

const TOKEN_FIELDS = ['input', 'output', 'total', 'cache_read', 'cache_write'] as const;

/**
 * The token counts of a `result` event, as TokensSchema. Null when the value
 * is not a result event, has no `tokens` object, or a count is not a
 * non-negative integer: an unreadable count is unknown, never zero. A count
 * Hermes left out is 0, as its emitter writes it (`or 0`).
 *
 * What the counts mean on the path a trial runs (the gateway daemon;
 * gateway/run_turn_runner.py:1316 and agent/usage_pricing.py:76), and
 * confirmed by the recorded run: `input` is every prompt token the provider
 * billed, cache reads and writes INCLUDED, summed over the run's model calls;
 * `cache_read` and `cache_write` are the parts of `input` served from or
 * written to the provider's cache; `output` is the completion tokens
 * (reasoning included); `total` is input + output. These equal the OpenAI
 * usage block the gateway sees (Phase 0, I4). pricing.ts relies on this.
 *
 * A turn that failed after a model call had answered (seen with the
 * gateway's token-cap 429) reports its input and output but no
 * `total_tokens`, which the emitter writes as 0 (hermes_cli/stream_json.py
 * emit_result). Its total is then input + output, so the run that used the
 * most tokens never reads as 0 where totals are summed, averaged or sorted.
 */
export function resultTokens(event: unknown): Tokens | null {
  if (!isRecord(event) || event.type !== 'result' || !isRecord(event.tokens)) return null;
  const counts: Record<string, number> = {};
  for (const field of TOKEN_FIELDS) {
    const value = event.tokens[field] ?? 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
    counts[field] = value;
  }
  if (counts.total === 0) counts.total = counts.input! + counts.output!;
  return TokensSchema.parse(counts);
}

/** An MCP tool as Hermes names it in tool_use and tool_result events. */
export interface McpToolRef {
  /** The MCP server's name as configured (the `-t` alias), or the sanitized component when unknown. */
  server: string;
  /** The tool as Hermes registered it: sanitized, and cut with a hash suffix past 64 characters. */
  tool: string;
}

/** Hermes's prefix for every MCP tool (tools/mcp_tool_schema.py MCP_TOOL_NAME_PREFIX). */
export const MCP_TOOL_PREFIX = 'mcp__';
const MCP_TOOL_NAME_MAX = 64;
const MCP_TOOL_HASH_CHARS = 8;

/**
 * Hermes's sanitize_mcp_name_component: every character outside [A-Za-z0-9_]
 * becomes `_`, one per code point as in Python (hence the `u` flag: an emoji
 * is one `_`, not two).
 */
export const sanitizeMcpNameComponent = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]/gu, '_');

/**
 * The name Hermes gives tool `tool` of MCP server `server` (plan 21 S3),
 * mirroring mcp_prefixed_tool_name (tools/mcp_tool_schema.py:173):
 * `mcp__<server>__<tool>` with both parts sanitized, and when that passes 64
 * characters, cut to 55 plus `_` and the first 8 hex digits of its sha256.
 * The per-server utility tools (list_resources, read_resource, list_prompts,
 * get_prompt) are named the same way. Observed in the recorded run:
 * `invoice-db`'s get_invoice is `mcp__invoice_db__get_invoice`, in tool_use
 * and tool_result alike, also when the agent reaches it through Hermes's
 * tool_search bridge (`tool_call`), whose events carry the inner name.
 */
export function hermesMcpToolName(server: string, tool: string): string {
  const full = `${MCP_TOOL_PREFIX}${sanitizeMcpNameComponent(server)}__${sanitizeMcpNameComponent(tool)}`;
  if (full.length <= MCP_TOOL_NAME_MAX) return full;
  const suffix = `_${createHash('sha256').update(full, 'utf8').digest('hex').slice(0, MCP_TOOL_HASH_CHARS)}`;
  return full.slice(0, MCP_TOOL_NAME_MAX - suffix.length) + suffix;
}

/**
 * Which MCP server a tool name from a tool_use or tool_result event belongs
 * to, or null when it is not an MCP tool.
 *
 * Pass the configuration's MCP server names (AttemptPlan or the launch
 * record) whenever they are known: the sanitized server part may itself
 * contain `__`, so only the configured names attribute a tool for certain,
 * and `server` is then the configured name. The longest matching name wins.
 * Two configured names that sanitize alike (`a-b` and `a_b`) collide in
 * Hermes too; the first in the list wins here. Without names, the server is
 * the sanitized part up to the first `__`.
 */
export function parseMcpToolName(name: string, serverNames?: readonly string[]): McpToolRef | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  if (serverNames !== undefined) {
    let best: McpToolRef | null = null;
    let bestLength = -1;
    for (const server of serverNames) {
      const prefix = `${sanitizeMcpNameComponent(server)}__`;
      if (prefix.length > bestLength && rest.startsWith(prefix) && rest.length > prefix.length) {
        best = { server, tool: rest.slice(prefix.length) };
        bestLength = prefix.length;
      }
    }
    return best;
  }
  const split = rest.indexOf('__');
  if (split <= 0 || split + 2 >= rest.length) return null;
  return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
}
