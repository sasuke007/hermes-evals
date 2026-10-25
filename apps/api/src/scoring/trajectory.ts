/**
 * trajectory_match (plan 9.3, Phase 3 S5): what the agent did, read from the
 * attempt's `tool_use` and `tool_result` events (ScorerContext.events(),
 * trajectory-calls.ts).
 *
 * - Count rule (no `mode`): the calls whose name equals `params.tool` (an
 *   MCP tool under Hermes's `mcp__<server>__<tool>` name) and whose
 *   arguments contain `params.args` as a deep subset, counted against
 *   `min_calls` and `max_calls`. Passed or failed, score 1 or 0.
 * - With `mode` (strict, unordered, subset, superset): openevals' trajectory
 *   match (trajectory-modes.ts) of the agent's message list against a
 *   reference of `min_calls` calls of `tool` with `args`, each answered by a
 *   tool message. So `superset` with the default min_calls of 1 means "called
 *   it at least once, among anything else"; `subset` "called nothing else,
 *   and it at most min_calls times"; `unordered` "called it exactly
 *   min_calls times and nothing else"; `strict` the same, each call with its
 *   result. A call matches when its name is `tool` and its arguments hold
 *   `args`, as in the count rule. `max_calls` is not read; the loader warns
 *   when both are set.
 *
 * Evidence: `event_seqs` and `evidence.trajectory.matched_seqs` hold the
 * tool_use sequence numbers of the calls of `tool` that match `args`;
 * `trajectory.calls` counts the calls of `tool` (count rule) or every tool
 * call (with a mode) (records.ts TrajectoryEvidenceSchema). No answer is
 * needed, so the key is never `ungradable`; events it cannot read give
 * `error`.
 */
import type { JsonValue, TrajectoryMatchParams } from '@hermes-evals/shared';
import { binary, describeThrown, scorerError, type ScorerResult } from './result.js';
import {
  agentMessages,
  argsMatch,
  readToolCalls,
  referenceMessages,
  TrajectoryReadError,
  type ToolCall,
  type TrajectoryEvent,
} from './trajectory-calls.js';
import { trajectoryMatches, type ArgsMatcher } from './trajectory-modes.js';

export type { TrajectoryEvent } from './trajectory-calls.js';

type JsonObject = { [key: string]: JsonValue };

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** ` with {"path":"invoices.csv"}`, or nothing without args. */
const withArgs = (args: JsonObject | undefined): string =>
  args && Object.keys(args).length > 0 ? ` with ${JSON.stringify(args)}` : '';

/** What the agent called instead, for a key that found no call of its tool: `read_file ×2, terminal`. */
function otherTools(calls: readonly ToolCall[]): string {
  if (calls.length === 0) return 'no tool was called';
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const named = [...counts].map(([name, n]) => (n === 1 ? name : `${name} ×${n}`));
  const listed =
    named.length <= 6
      ? named.join(', ')
      : `${named.slice(0, 6).join(', ')} and ${named.length - 6} more`;
  return `tools called: ${listed}`;
}

function bounds(params: TrajectoryMatchParams): string {
  const { min_calls: min, max_calls: max } = params;
  if (max === undefined) return `at least ${min}`;
  if (max === min) return `exactly ${min}`;
  return min === 0 ? `at most ${max}` : `${min} to ${max}`;
}

function countRule(calls: readonly ToolCall[], params: TrajectoryMatchParams): ScorerResult {
  const named = calls.filter((c) => c.name === params.tool);
  const matched = named.filter((c) => argsMatch(c.args, params.args));
  const n = matched.length;
  const passed = n >= params.min_calls && (params.max_calls === undefined || n <= params.max_calls);
  const what = `${params.tool}${withArgs(params.args)}`;
  let observed: string;
  if (named.length === 0) observed = `no call to ${params.tool} (${otherTools(calls)})`;
  else if (params.args === undefined || named.length === n)
    observed = `${plural(n, 'call')} to ${what}`;
  else
    observed = `${n} of ${plural(named.length, 'call')} to ${params.tool} match ${JSON.stringify(params.args)}`;
  const seqs = matched.map((c) => c.seq);
  return binary(passed, `${observed}; needs ${bounds(params)}`, {
    observed: n,
    expected: {
      min_calls: params.min_calls,
      ...(params.max_calls !== undefined ? { max_calls: params.max_calls } : {}),
    },
    evidence: {
      event_seqs: seqs,
      trajectory: { tool: params.tool, calls: named.length, matched_seqs: seqs },
    },
  });
}

/** The argument rule as openevals' per-tool override receives it: the agent's args, then the reference's. */
const matcher: ArgsMatcher = (agentArgs, referenceArgs) =>
  argsMatch(
    typeof agentArgs === 'object' && agentArgs !== null && !Array.isArray(agentArgs)
      ? (agentArgs as JsonObject)
      : null,
    referenceArgs as JsonObject,
  );

/** What each mode asks of the agent, given the reference of `n` calls of one tool. */
const MODE_RULE = {
  strict: (n: number, what: string) =>
    `exactly ${plural(n, 'call')} to ${what}, each with its result, and no other tool call`,
  unordered: (n: number, what: string) =>
    `exactly ${plural(n, 'call')} to ${what}, and no other tool call`,
  subset: (n: number, what: string) =>
    `at most ${plural(n, 'call')} to ${what}, and no other tool call`,
  superset: (n: number, what: string) => `at least ${plural(n, 'call')} to ${what}`,
} as const;

function modeRule(calls: readonly ToolCall[], params: TrajectoryMatchParams): ScorerResult {
  const mode = params.mode!;
  const passed = trajectoryMatches(
    mode,
    agentMessages(calls),
    referenceMessages(params.tool, params.args, params.min_calls),
    matcher,
  );
  const seqs = calls
    .filter((c) => c.name === params.tool && argsMatch(c.args, params.args))
    .map((c) => c.seq);
  const what = `${params.tool}${withArgs(params.args)}`;
  const comment =
    `${mode} trajectory match ${passed ? 'passed' : 'failed'}: ${plural(calls.length, 'tool call')}, ` +
    `${seqs.length} of them to ${what}; needs ${MODE_RULE[mode](params.min_calls, what)}`;
  return binary(passed, comment, {
    observed: calls.length,
    evidence: {
      event_seqs: seqs,
      trajectory: { tool: params.tool, calls: calls.length, matched_seqs: seqs, mode },
    },
  });
}

/** Grades one trajectory_match key over the attempt's events. Synchronous; never throws. */
export function scoreTrajectory(
  events: readonly TrajectoryEvent[],
  params: TrajectoryMatchParams,
): ScorerResult {
  try {
    const calls = readToolCalls(events);
    return params.mode === undefined ? countRule(calls, params) : modeRule(calls, params);
  } catch (err) {
    if (err instanceof TrajectoryReadError) {
      return scorerError(`could not read the attempt's tool calls: ${err.message}`);
    }
    const { message, detail } = describeThrown(err);
    return scorerError(`the scorer failed: ${message}`, detail);
  }
}
