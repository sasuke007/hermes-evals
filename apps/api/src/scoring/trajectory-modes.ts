/**
 * openevals' four trajectory match modes (openevals 0.2.3,
 * trajectory/strict.js, unordered.js, subset.js, superset.js and utils.js
 * `_isTrajectorySuperset`), over the OpenAI-style message lists of
 * trajectory-calls.ts:
 *
 * - `strict`: the same messages in the same order: equal length, equal
 *   roles, and each assistant message's tool calls matched one to one;
 * - `unordered`: the same tool calls in any order (superset both ways);
 * - `subset`: every agent call matches a distinct reference call;
 * - `superset`: every reference call matches a distinct agent call.
 *
 * A pair of calls matches when the names are equal and the argument rule
 * holds (trajectory_match's deep-subset rule, which openevals takes as a
 * per-tool override). Matching is greedy in list order, exactly as openevals
 * does it.
 *
 * Why not call createTrajectoryMatchEvaluator: every call goes through
 * LangSmith's traceable wrapper, which uploads the trajectory (the agent's
 * tool arguments and results) when tracing variables are set, and it is
 * asynchronous where the scorer is synchronous. json-match.ts drops openevals
 * for the same reason. trajectory.spec.ts checks every mode against
 * openevals itself on the same trajectories, so the semantics cannot drift
 * unnoticed.
 */
import type { TrajectoryMode } from '@hermes-evals/shared';
import type { TrajectoryMessage, TrajectoryToolCall } from './trajectory-calls.js';

/** Whether an agent call's arguments satisfy a reference call's; both parsed from JSON text. */
export type ArgsMatcher = (agentArgs: unknown, referenceArgs: unknown) => boolean;

const parseArgs = (call: TrajectoryToolCall): unknown => JSON.parse(call.function.arguments);

const toolCallsOf = (messages: readonly TrajectoryMessage[]): TrajectoryToolCall[] =>
  messages.flatMap((m) => (m.role === 'assistant' ? m.tool_calls : []));

/**
 * openevals' `_isTrajectorySuperset(outputs, reference)`: every call of
 * `reference` is matched by a distinct call of `outputs`. `swapped` says the
 * agent's list was passed as `reference`, so the matcher still receives the
 * agent's arguments first.
 */
function isSuperset(
  outputs: readonly TrajectoryMessage[],
  reference: readonly TrajectoryMessage[],
  matches: ArgsMatcher,
  swapped: boolean,
): boolean {
  const outputCalls = toolCallsOf(outputs);
  const used = new Set<number>();
  for (const refCall of toolCallsOf(reference)) {
    const index = outputCalls.findIndex((outCall, i) => {
      if (used.has(i) || outCall.function.name !== refCall.function.name) return false;
      const outArgs = parseArgs(outCall);
      const refArgs = parseArgs(refCall);
      return swapped ? matches(refArgs, outArgs) : matches(outArgs, refArgs);
    });
    if (index < 0) return false;
    used.add(index);
  }
  return true;
}

function isStrictMatch(
  outputs: readonly TrajectoryMessage[],
  reference: readonly TrajectoryMessage[],
  matches: ArgsMatcher,
): boolean {
  if (outputs.length !== reference.length) return false;
  return outputs.every((output, i) => {
    const ref = reference[i]!;
    if (output.role !== ref.role) return false;
    if (output.role !== 'assistant' || ref.role !== 'assistant') return true;
    if (output.tool_calls.length !== ref.tool_calls.length) return false;
    const seen = ref.tool_calls.map(() => false);
    return output.tool_calls.every((outCall) => {
      const j = ref.tool_calls.findIndex(
        (refCall, k) =>
          !seen[k] &&
          outCall.function.name === refCall.function.name &&
          matches(parseArgs(outCall), parseArgs(refCall)),
      );
      if (j < 0) return false;
      seen[j] = true;
      return true;
    });
  });
}

/** Whether the agent's trajectory matches the reference in `mode`. */
export function trajectoryMatches(
  mode: TrajectoryMode,
  agent: readonly TrajectoryMessage[],
  reference: readonly TrajectoryMessage[],
  matches: ArgsMatcher,
): boolean {
  switch (mode) {
    case 'strict':
      return isStrictMatch(agent, reference, matches);
    case 'unordered':
      return (
        isSuperset(agent, reference, matches, false) && isSuperset(reference, agent, matches, true)
      );
    case 'subset':
      return isSuperset(reference, agent, matches, true);
    case 'superset':
      return isSuperset(agent, reference, matches, false);
  }
}
