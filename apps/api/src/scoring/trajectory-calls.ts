/**
 * The agent's tool calls, read from an attempt's stored `tool_use` and
 * `tool_result` events (execution/stream-json.ts has Hermes's shapes):
 *
 *   tool_use:    {"name": …, "tool_call_id": …, "input": {…}}
 *   tool_result: {"name": …, "tool_call_id": …, "output": …, "is_error": …}
 *
 * An MCP tool is named `mcp__<server>__<tool>` in both, also when the agent
 * reached it through Hermes's tool_search bridge (the events carry the inner
 * name). A result is paired with its call by `tool_call_id`, or, when the
 * call had none, with the earliest open call of the same name, the rule the
 * run inspector's timeline uses (runs/views/timeline.ts). A result whose call
 * was never seen is not a call and is left out.
 *
 * Also builds the OpenAI-style message list openevals' trajectory match
 * reads: each call as an assistant message with one tool call, followed by
 * a tool message when its result arrived, in call order. Hermes does not
 * say which calls one model turn made together, so each call is its own
 * turn, the same rule for the agent's list and the reference's.
 */
import { z } from 'zod';
import type { JsonValue, RunEventPayload, RunEventType } from '@hermes-evals/shared';

type JsonObject = { [key: string]: JsonValue };

/**
 * One stored event, in sequence order: the fields trajectory_match reads of
 * evaluation/evidence.ts EventRecord, so either can be passed.
 */
export interface TrajectoryEvent {
  seq: number;
  type: RunEventType;
  payload: RunEventPayload;
}

/** One tool call of the attempt. */
export interface ToolCall {
  /** Sequence number of its tool_use event. */
  seq: number;
  name: string;
  /** Hermes's `tool_call_id`; null when the event had none. */
  callId: string | null;
  /**
   * The call's arguments: `input` as an object, or a JSON string of one.
   * Null when they cannot be read as an object; such a call still counts by
   * name, but never matches a required argument.
   */
  args: JsonObject | null;
  /** Its tool_result, when one arrived. */
  result: { seq: number; output: string; isError: boolean } | null;
}

/** An event the scorer cannot read, which makes the key `error` (S5). */
export class TrajectoryReadError extends Error {
  override readonly name = 'TrajectoryReadError';
}

const ToolUsePayloadSchema = z.looseObject({
  name: z.string().min(1),
  tool_call_id: z.string().nullish(),
  input: z.unknown().optional(),
});

const ToolResultPayloadSchema = z.looseObject({
  name: z.string().min(1),
  tool_call_id: z.string().nullish(),
  output: z.unknown().optional(),
  is_error: z.unknown().optional(),
});

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `input` as Hermes logged it: an object, a JSON string of one, or absent (no arguments). */
function readArgs(input: unknown): JsonObject | null {
  if (input === undefined || input === null) return {};
  if (isObject(input)) return input;
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return isObject(parsed) ? (parsed as JsonObject) : null;
    } catch {
      return null;
    }
  }
  return null;
}

const outputText = (output: unknown): string =>
  output === undefined || output === null
    ? ''
    : typeof output === 'string'
      ? output
      : JSON.stringify(output);

/**
 * The attempt's tool calls in call order. Throws TrajectoryReadError on a
 * tool_use or tool_result event without a tool name; the stored-event schema
 * requires one, so only a hand-edited row gets there.
 */
export function readToolCalls(events: readonly TrajectoryEvent[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const open: ToolCall[] = [];
  for (const event of events) {
    if (event.type === 'tool_use') {
      const parsed = ToolUsePayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw new TrajectoryReadError(`event ${event.seq} is a tool_use without a tool name`);
      }
      const call: ToolCall = {
        seq: event.seq,
        name: parsed.data.name,
        callId: parsed.data.tool_call_id ?? null,
        args: readArgs(parsed.data.input),
        result: null,
      };
      calls.push(call);
      open.push(call);
    } else if (event.type === 'tool_result') {
      const parsed = ToolResultPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        throw new TrajectoryReadError(`event ${event.seq} is a tool_result without a tool name`);
      }
      const callId = parsed.data.tool_call_id ?? null;
      const index = callId
        ? open.findIndex((c) => c.callId === callId)
        : open.findIndex((c) => c.callId === null && c.name === parsed.data.name);
      if (index < 0) continue;
      const [call] = open.splice(index, 1);
      call!.result = {
        seq: event.seq,
        output: outputText(parsed.data.output),
        isError: parsed.data.is_error === true,
      };
    }
  }
  return calls;
}

/**
 * Whether `actual` holds `wanted` as a deep subset: every key of a wanted
 * object is in the actual object with a matching value, recursively; a list
 * must have the same length and match item by item, in order; anything else
 * must be equal (no coercion: the string "1" is not the number 1).
 */
export function containsSubset(actual: unknown, wanted: JsonValue): boolean {
  if (Array.isArray(wanted)) {
    return (
      Array.isArray(actual) &&
      actual.length === wanted.length &&
      wanted.every((item, i) => containsSubset(actual[i], item))
    );
  }
  if (isObject(wanted)) {
    if (!isObject(actual)) return false;
    return Object.entries(wanted).every(
      ([key, value]) => Object.hasOwn(actual, key) && containsSubset(actual[key], value),
    );
  }
  return actual === wanted;
}

/**
 * The argument rule of trajectory_match: no `args` (or `{}`) matches any
 * call, unreadable arguments included; otherwise the call's arguments must
 * hold `wanted` as a deep subset.
 */
export function argsMatch(actual: JsonObject | null, wanted: JsonObject | undefined): boolean {
  if (wanted === undefined || Object.keys(wanted).length === 0) return true;
  return actual !== null && containsSubset(actual, wanted);
}

// ---------------------------------------------------------------------------
// OpenAI-style messages (what openevals' trajectory evaluators read)
// ---------------------------------------------------------------------------

export interface TrajectoryToolCall {
  id: string;
  type: 'function';
  /** `arguments` is JSON text, as the OpenAI API sends it. */
  function: { name: string; arguments: string };
}

export type TrajectoryMessage =
  | { role: 'assistant'; content: string; tool_calls: TrajectoryToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** A call's arguments as JSON text; unreadable arguments as `null`, which parses to no object. */
const argumentsText = (args: JsonObject | null): string => JSON.stringify(args);

/** The agent's trajectory: each call, then its result when one arrived. */
export function agentMessages(calls: readonly ToolCall[]): TrajectoryMessage[] {
  return calls.flatMap((call): TrajectoryMessage[] => {
    const id = call.callId ?? `seq_${call.seq}`;
    const use: TrajectoryMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: call.name, arguments: argumentsText(call.args) },
        },
      ],
    };
    return call.result
      ? [use, { role: 'tool', tool_call_id: id, content: call.result.output }]
      : [use];
  });
}

/** The reference trajectory of a mode: `count` calls of `tool` with `args`, each answered. */
export function referenceMessages(
  tool: string,
  args: JsonObject | undefined,
  count: number,
): TrajectoryMessage[] {
  return Array.from({ length: count }, (_, i): TrajectoryMessage[] => {
    const id = `reference_${i + 1}`;
    return [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id, type: 'function', function: { name: tool, arguments: JSON.stringify(args ?? {}) } },
        ],
      },
      { role: 'tool', tool_call_id: id, content: '' },
    ];
  }).flat();
}
