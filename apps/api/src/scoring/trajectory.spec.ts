import {
  ScoreEvidenceSchema,
  TRAJECTORY_MODES,
  type JsonValue,
  type RunEventPayload,
  type TrajectoryMode,
} from '@hermes-evals/shared';
import { createTrajectoryMatchEvaluator } from 'openevals';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hermesMcpToolName } from '../execution/stream-json.js';
import { parseScorerParams } from './registry.js';
import { scoreTrajectory, type TrajectoryEvent } from './trajectory.js';
import {
  agentMessages,
  argsMatch,
  containsSubset,
  readToolCalls,
  referenceMessages,
} from './trajectory-calls.js';
import { trajectoryMatches } from './trajectory-modes.js';

function params(written: Record<string, unknown>) {
  const parsed = parseScorerParams('trajectory_match', written);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

type Call = { name: string; input?: unknown; id?: string | null; result?: boolean };

/**
 * Events as Hermes writes them (execution/stream-json.ts): each tool_use
 * followed by its tool_result, numbered from 1, with an init and a result
 * around them.
 */
function events(calls: readonly Call[]): TrajectoryEvent[] {
  const payloads: RunEventPayload[] = [{ type: 'system', subtype: 'init' }];
  calls.forEach((call, i) => {
    const id = call.id === undefined ? `call_${i}` : call.id;
    payloads.push({
      type: 'tool_use',
      name: call.name,
      ...(id !== null ? { tool_call_id: id } : {}),
      ...(call.input !== undefined ? { input: call.input } : {}),
    } as RunEventPayload);
    if (call.result !== false) {
      payloads.push({
        type: 'tool_result',
        name: call.name,
        ...(id !== null ? { tool_call_id: id } : {}),
        output: '{"output": "ok"}',
        is_error: false,
      } as RunEventPayload);
    }
  });
  payloads.push({ type: 'result', text: 'done' });
  return payloads.map((payload, i) => ({ seq: i + 1, type: payload.type, payload }));
}

const READ_LEDGER: Call = { name: 'read_file', input: { path: 'invoices.csv', limit: 500 } };
const TERMINAL: Call = { name: 'terminal', input: { command: 'wc -l invoices.csv' } };
const GET_INVOICE = hermesMcpToolName('invoice-db', 'get_invoice');

describe('the count rule', () => {
  it('passes the brief sample: read_file with { path: invoices.csv } at least once', () => {
    const result = scoreTrajectory(
      events([TERMINAL, READ_LEDGER, READ_LEDGER]),
      params({ tool: 'read_file', args: { path: 'invoices.csv' } }),
    );
    expect(result).toMatchObject({ status: 'passed', score: 1, observed: 2 });
    expect(result.comment).toBe(
      '2 calls to read_file with {"path":"invoices.csv"}; needs at least 1',
    );
    // Seqs: 1 init, 2-3 terminal, 4-5 and 6-7 read_file.
    expect(result.evidence).toEqual({
      event_seqs: [4, 6],
      trajectory: { tool: 'read_file', calls: 2, matched_seqs: [4, 6] },
    });
    expect(ScoreEvidenceSchema.parse(result.evidence)).toEqual(result.evidence);
    expect(result.expected).toEqual({ min_calls: 1 });
  });

  it('fails with no call of the tool, and lists what was called instead', () => {
    const result = scoreTrajectory(
      events([TERMINAL, TERMINAL, { name: 'search_files', input: {} }]),
      params({ tool: 'read_file' }),
    );
    expect(result).toMatchObject({ status: 'failed', score: 0, observed: 0 });
    expect(result.comment).toBe(
      'no call to read_file (tools called: terminal ×2, search_files); needs at least 1',
    );
    expect(result.evidence?.trajectory).toEqual({ tool: 'read_file', calls: 0, matched_seqs: [] });
    expect(scoreTrajectory(events([]), params({ tool: 'read_file' })).comment).toBe(
      'no call to read_file (no tool was called); needs at least 1',
    );
  });

  it('counts only calls whose arguments hold args', () => {
    const other = { name: 'read_file', input: { path: 'notes.md' } };
    const result = scoreTrajectory(
      events([other, READ_LEDGER]),
      params({ tool: 'read_file', args: { path: 'invoices.csv' }, min_calls: 2 }),
    );
    expect(result).toMatchObject({ status: 'failed', observed: 1 });
    expect(result.comment).toBe(
      '1 of 2 calls to read_file match {"path":"invoices.csv"}; needs at least 2',
    );
    expect(result.evidence?.trajectory).toEqual({ tool: 'read_file', calls: 2, matched_seqs: [4] });
  });

  it('applies max_calls, including never', () => {
    const three = events([READ_LEDGER, READ_LEDGER, READ_LEDGER]);
    expect(scoreTrajectory(three, params({ tool: 'read_file', max_calls: 2 })).comment).toBe(
      '3 calls to read_file; needs 1 to 2',
    );
    expect(scoreTrajectory(three, params({ tool: 'read_file', max_calls: 2 })).status).toBe(
      'failed',
    );
    expect(scoreTrajectory(three, params({ tool: 'read_file', max_calls: 3 })).status).toBe(
      'passed',
    );
    const never = params({ tool: 'terminal', min_calls: 0, max_calls: 0 });
    expect(scoreTrajectory(three, never)).toMatchObject({ status: 'passed', score: 1 });
    expect(scoreTrajectory(events([TERMINAL]), never)).toMatchObject({ status: 'failed' });
    expect(scoreTrajectory(events([TERMINAL]), never).comment).toBe(
      '1 call to terminal; needs exactly 0',
    );
    const atMost = params({ tool: 'terminal', min_calls: 0, max_calls: 1 });
    expect(scoreTrajectory(three, atMost).comment).toMatch(/needs at most 1$/);
  });

  it('matches MCP tools by the name Hermes gives them', () => {
    expect(GET_INVOICE).toBe('mcp__invoice_db__get_invoice');
    const calls = events([{ name: GET_INVOICE, input: { invoice_no: 'INV-1001' } }]);
    expect(
      scoreTrajectory(calls, params({ tool: GET_INVOICE, args: { invoice_no: 'INV-1001' } }))
        .status,
    ).toBe('passed');
    // The server's own name, or the bare tool, is not the name in the events.
    expect(scoreTrajectory(calls, params({ tool: 'get_invoice' })).status).toBe('failed');
    expect(scoreTrajectory(calls, params({ tool: 'mcp__invoice-db__get_invoice' })).status).toBe(
      'failed',
    );
  });

  it('reads arguments given as a JSON string, and counts unreadable ones by name only', () => {
    const asText = events([{ name: 'read_file', input: '{"path": "invoices.csv"}' }]);
    expect(
      scoreTrajectory(asText, params({ tool: 'read_file', args: { path: 'invoices.csv' } })).status,
    ).toBe('passed');
    const broken = events([
      { name: 'read_file', input: 'not json' },
      { name: 'read_file', input: 7 },
    ]);
    expect(scoreTrajectory(broken, params({ tool: 'read_file', min_calls: 2 })).status).toBe(
      'passed',
    );
    expect(
      scoreTrajectory(broken, params({ tool: 'read_file', args: { path: 'invoices.csv' } })).status,
    ).toBe('failed');
    // No input at all is a call without arguments.
    expect(
      scoreTrajectory(events([{ name: 'list_files' }]), params({ tool: 'list_files' })).status,
    ).toBe('passed');
  });

  it('is never ungradable: an attempt without events fails or passes on its count', () => {
    expect(scoreTrajectory([], params({ tool: 'read_file' })).status).toBe('failed');
    expect(scoreTrajectory([], params({ tool: 'read_file', min_calls: 0 })).status).toBe('passed');
  });

  it('errors on a tool event it cannot read', () => {
    const forged: TrajectoryEvent[] = [
      { seq: 1, type: 'tool_use', payload: { type: 'tool_use' } as unknown as RunEventPayload },
    ];
    const result = scoreTrajectory(forged, params({ tool: 'read_file' }));
    expect(result).toMatchObject({
      status: 'error',
      score: null,
      comment: "could not read the attempt's tool calls: event 1 is a tool_use without a tool name",
    });
    const result2 = scoreTrajectory(
      [{ seq: 4, type: 'tool_result', payload: { type: 'tool_result', name: '' } }],
      params({ tool: 'read_file' }),
    );
    expect(result2.status).toBe('error');
    expect(result2.comment).toMatch(/event 4 is a tool_result without a tool name/);
  });
});

describe('containsSubset and argsMatch', () => {
  it.each<[unknown, JsonValue, boolean]>([
    [{ path: 'a', limit: 5 }, { path: 'a' }, true],
    [{ path: 'a' }, { path: 'a', limit: 5 }, false],
    [{ q: { where: { id: 1, x: 2 }, order: 'asc' } }, { q: { where: { id: 1 } } }, true],
    [{ q: { where: { id: 2 } } }, { q: { where: { id: 1 } } }, false],
    [{ ids: [1, 2] }, { ids: [1, 2] }, true],
    [{ ids: [1, 2, 3] }, { ids: [1, 2] }, false],
    [{ ids: [2, 1] }, { ids: [1, 2] }, false],
    [{ rows: [{ id: 1, v: 'x' }] }, { rows: [{ id: 1 }] }, true],
    [{ n: '1' }, { n: 1 }, false],
    [{ n: null }, { n: null }, true],
    [{}, { n: null }, false],
    [{ a: 'A' }, { a: 'a' }, false],
  ])('%j holds %j: %s', (actual, wanted, expected) => {
    expect(containsSubset(actual, wanted)).toBe(expected);
  });

  it('accepts any call when no args are required', () => {
    expect(argsMatch(null, undefined)).toBe(true);
    expect(argsMatch(null, {})).toBe(true);
    expect(argsMatch(null, { path: 'a' })).toBe(false);
  });
});

describe('reading calls', () => {
  it('pairs results by tool_call_id, else with the earliest open call of the same name', () => {
    const payloads: RunEventPayload[] = [
      { type: 'tool_use', name: 'read_file', tool_call_id: 'a', input: { path: '1' } },
      { type: 'tool_use', name: 'read_file', tool_call_id: 'b', input: { path: '2' } },
      { type: 'tool_result', name: 'read_file', tool_call_id: 'b', output: 'two' },
      { type: 'tool_use', name: 'terminal', input: {} },
      { type: 'tool_result', name: 'terminal', output: { exit_code: 0 } },
      { type: 'tool_result', name: 'read_file', tool_call_id: 'zzz', output: 'orphan' },
    ];
    const calls = readToolCalls(
      payloads.map((payload, i) => ({ seq: i + 1, type: payload.type, payload })),
    );
    expect(
      calls.map((c) => [c.seq, c.name, c.result?.seq ?? null, c.result?.output ?? null]),
    ).toEqual([
      [1, 'read_file', null, null],
      [2, 'read_file', 3, 'two'],
      [4, 'terminal', 5, '{"exit_code":0}'],
    ]);
    expect(agentMessages(calls).map((m) => m.role)).toEqual([
      'assistant',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ]);
    expect(agentMessages(calls)[3]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'seq_4', type: 'function', function: { name: 'terminal', arguments: '{}' } },
      ],
    });
  });
});

describe('modes', () => {
  const mode = (m: TrajectoryMode, calls: Call[], extra: Record<string, unknown> = {}) =>
    scoreTrajectory(
      events(calls),
      params({ tool: 'read_file', args: { path: 'invoices.csv' }, mode: m, ...extra }),
    );

  it('strict: exactly the reference calls, each with its result', () => {
    expect(mode('strict', [READ_LEDGER]).status).toBe('passed');
    expect(mode('strict', [READ_LEDGER, TERMINAL]).status).toBe('failed');
    expect(mode('strict', [{ ...READ_LEDGER, result: false }]).status).toBe('failed');
    expect(mode('strict', [READ_LEDGER, READ_LEDGER], { min_calls: 2 }).status).toBe('passed');
  });

  it('unordered: the same calls in any order', () => {
    expect(mode('unordered', [READ_LEDGER]).status).toBe('passed');
    expect(mode('unordered', [{ ...READ_LEDGER, result: false }]).status).toBe('passed');
    expect(mode('unordered', [TERMINAL, READ_LEDGER]).status).toBe('failed');
  });

  it('subset: nothing beyond the reference', () => {
    expect(mode('subset', []).status).toBe('passed');
    expect(mode('subset', [READ_LEDGER]).status).toBe('passed');
    expect(mode('subset', [READ_LEDGER, READ_LEDGER]).status).toBe('failed');
    expect(mode('subset', [TERMINAL]).status).toBe('failed');
  });

  it('superset: at least the reference, among anything else', () => {
    const result = mode('superset', [TERMINAL, READ_LEDGER, TERMINAL]);
    expect(result).toMatchObject({ status: 'passed', score: 1, observed: 3 });
    expect(result.comment).toBe(
      'superset trajectory match passed: 3 tool calls, 1 of them to read_file with {"path":"invoices.csv"}; needs at least 1 call to read_file with {"path":"invoices.csv"}',
    );
    expect(result.evidence).toEqual({
      event_seqs: [4],
      trajectory: { tool: 'read_file', calls: 3, matched_seqs: [4], mode: 'superset' },
    });
    expect(ScoreEvidenceSchema.parse(result.evidence)).toEqual(result.evidence);
    expect(mode('superset', [TERMINAL, { name: 'read_file', input: { path: 'x' } }]).status).toBe(
      'failed',
    );
  });
});

/**
 * The modes are ours (trajectory-modes.ts says why), so they are checked
 * against openevals' own evaluator, with trajectory_match's argument rule as
 * its per-tool override, on trajectories that exercise each rule.
 */
describe('the modes agree with openevals', () => {
  // openevals runs every evaluator through LangSmith's traceable wrapper; keep it from uploading.
  beforeAll(() => {
    vi.stubEnv('LANGSMITH_TRACING', 'false');
    vi.stubEnv('LANGCHAIN_TRACING_V2', 'false');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  const tool = 'read_file';
  const args = { path: 'invoices.csv' };
  const trajectories: Record<string, Call[]> = {
    none: [],
    one: [READ_LEDGER],
    two: [READ_LEDGER, READ_LEDGER],
    unanswered: [{ ...READ_LEDGER, result: false }],
    otherArgs: [{ name: tool, input: { path: 'notes.md' } }],
    noArgs: [{ name: tool }],
    unreadableArgs: [{ name: tool, input: 'oops' }],
    mixed: [TERMINAL, READ_LEDGER, TERMINAL],
    mixedTwo: [READ_LEDGER, TERMINAL, READ_LEDGER],
    other: [TERMINAL],
    mcp: [{ name: GET_INVOICE, input: { invoice_no: 'INV-1' } }, READ_LEDGER],
  };
  const cases = TRAJECTORY_MODES.flatMap((m) =>
    Object.keys(trajectories).flatMap((name) =>
      [0, 1, 2].flatMap((minCalls) =>
        [args, undefined].map((wanted) => ({ m, name, minCalls, wanted })),
      ),
    ),
  );

  it(`gives the same verdict on all ${cases.length} cases`, async () => {
    const disagreements: string[] = [];
    for (const { m, name, minCalls, wanted } of cases) {
      const calls = readToolCalls(events(trajectories[name]!));
      const agent = agentMessages(calls);
      const reference = referenceMessages(tool, wanted, minCalls);
      const matcher = (a: unknown, r: unknown) =>
        argsMatch(
          typeof a === 'object' && a !== null && !Array.isArray(a)
            ? (a as { [k: string]: JsonValue })
            : null,
          r as { [k: string]: JsonValue },
        );
      const ours = trajectoryMatches(m, agent, reference, matcher);
      const evaluator = createTrajectoryMatchEvaluator({
        trajectoryMatchMode: m,
        toolArgsMatchMode: 'exact',
        // Every tool the trajectories call, so no call falls back to exact matching.
        toolArgsMatchOverrides: Object.fromEntries(
          [tool, 'terminal', GET_INVOICE].map((t) => [t, matcher]),
        ),
      });
      const theirs = await evaluator({ outputs: agent, referenceOutputs: reference });
      if (theirs.score !== ours) {
        disagreements.push(
          `${m} ${name} min_calls=${minCalls} args=${JSON.stringify(wanted)}: ours ${ours}, openevals ${String(theirs.score)}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });
});
