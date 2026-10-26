/**
 * The timeline built from stored events: the recorded Hermes run (real
 * stream-json lines), egress's connection log appended after it the way the
 * worker stores it at the end of an attempt, and the paging the inspector
 * polls with. Every row parses with the shared TimelineEvent schema.
 */
import { describe, expect, it } from 'vitest';
import { TimelineEventSchema, type TimelineEvent } from '@hermes-evals/shared';
import { networkEvents } from '../../execution/attempt/network-events.js';
import { parseStreamLine } from '../../execution/stream-json.js';
import type { EgressLogEntry } from '../../sandbox/egress-client.js';
import {
  RECORDED_PROVIDER_FAILURE,
  RECORDED_RUN,
  RECORDED_START_MS,
  recordedEvents,
} from './recorded-run-spec.js';
import type { EventRecord } from './rows.js';
import {
  buildTimeline,
  timelinePage,
  TOOL_OUTPUT_LIMIT,
  turnsSoFar,
  type TimelineContext,
} from './timeline.js';

/** The attempt started 300 ms before Hermes printed its init line. */
const START = RECORDED_START_MS - 300;
const CTX: TimelineContext = {
  startedAtMs: START,
  mcpServers: ['invoice-db'],
  forwardedTo: 'mock-model:8090',
};

const events = (rows: ReturnType<typeof buildTimeline>): TimelineEvent[] =>
  rows.map((r) => TimelineEventSchema.parse(r.event));

/** A `network` platform event as the worker stores egress's connection log. */
const network = (seq: number, ts: number, fields: Record<string, unknown>): EventRecord => ({
  seq,
  ts,
  type: 'platform',
  payload: { type: 'platform', subtype: 'network', background: false, ...fields } as never,
});

const line = (seq: number, value: unknown, ts = START + seq * 100): EventRecord => {
  const event = parseStreamLine(JSON.stringify(value), ts);
  return { seq, ts: event.ts, type: event.type, payload: event.payload };
};

// Recorded times: tool_use get_invoice +5,698 ms after init, its result +7 ms,
// terminal +5,720 to +5,761, text +5,765, result +5,789.
const T_TERMINAL = RECORDED_START_MS + 5_720;

describe('the recorded run', () => {
  const rows = buildTimeline(recordedEvents(), CTX);
  const shown = events(rows);

  it('pairs each tool_use with its tool_result into one row, in time order', () => {
    expect(shown.map((e) => [e.seq, e.kind, e.title])).toEqual([
      [1, 'platform', 'init'],
      [2, 'tool', 'get_invoice'],
      [4, 'tool', 'terminal'],
      [6, 'text', 'text'],
      [7, 'final', 'final response'],
    ]);
    expect(shown.map((e) => e.atMs)).toEqual([300, 5998, 6020, 6065, 6089]);
  });

  it('tags the MCP tool with its configured server and keeps input and output verbatim', () => {
    const mcp = shown[1]!;
    expect(mcp).toMatchObject({
      server: 'invoice-db',
      summary: '{"invoice_no":"INV-1001"}',
      input: '{"invoice_no":"INV-1001"}',
      durationMs: 7,
      running: false,
      error: false,
      truncated: false,
    });
    const raw = JSON.parse(RECORDED_RUN[2]!) as { output: string };
    expect(mcp.output).toBe(raw.output);
    expect(mcp.outputChars).toBe(raw.output.length);
  });

  it('summarises a terminal call by its command', () => {
    expect(shown[2]).toMatchObject({
      server: null,
      summary: 'echo hello > /tmp/ws/out.txt && cat /tmp/ws/out.txt',
      durationMs: 40,
    });
  });

  it('draws the result as the final response, with its own text, not the streamed one', () => {
    const final = shown[4]!;
    expect(final.summary).toBe('Total done.');
    expect(final.text).toBe('Total done.\n```json\n{"total": 1042}\n```');
    expect(final.durationMs).toBe(5789);
    expect(shown[3]!.text).toBe('\n\nTotal done.\n```json\n{"total": 1042}\n```');
  });

  it('counts three turns: one model call per tool call, then the answer', () => {
    expect(turnsSoFar(recordedEvents())).toBe(3);
  });
});

describe("egress's connection log", () => {
  const log: EventRecord[] = [
    network(8, START + 5_000, {
      kind: 'model',
      decision: 'allowed',
      model: 'mock/scripted',
      status: 200,
      ms: 900,
      tokens_in: 1000,
      tokens_out: 21,
    }),
    network(9, START + 5_900, {
      kind: 'model',
      decision: 'allowed',
      model: 'mock/scripted',
      status: 200,
    }),
    network(10, START + 600, {
      kind: 'connect',
      decision: 'denied',
      host: 'inference-api.nousresearch.com',
      port: 443,
      reason: 'not on the allowlist',
      background: true,
    }),
    network(11, T_TERMINAL + 10, {
      kind: 'connect',
      decision: 'denied',
      host: 'example.com',
      port: 443,
      reason: 'not on the allowlist',
    }),
    network(12, RECORDED_START_MS + 5_780, {
      kind: 'http',
      decision: 'denied',
      host: '10.0.0.5',
      port: 80,
      reason: 'private address',
    }),
    network(13, START + 3_000, {
      kind: 'mcp',
      decision: 'allowed',
      server: 'vendor-api',
      host: 'vendor.example',
      status: 200,
      ms: 40,
    }),
    network(14, START + 3_500, {
      kind: 'model',
      decision: 'denied',
      reason: 'token budget exhausted',
    }),
  ];
  const rows = buildTimeline([...recordedEvents(), ...log], CTX);
  const shown = events(rows);
  const bySeq = (seq: number) => shown.find((e) => e.seq === seq)!;

  it('places stored-late network rows by time, at the start of each call', () => {
    const atMs = shown.map((e) => e.atMs);
    expect(atMs).toEqual([...atMs].sort((a, b) => a - b));
    expect(bySeq(8).atMs).toBe(4100);
    expect(bySeq(13).atMs).toBe(2960);
  });

  it('draws a model call with its tokens when egress counted them', () => {
    expect(bySeq(8)).toMatchObject({
      kind: 'network',
      title: 'Model call',
      summary: 'mock/scripted · 200 · 1,021 tokens (1,000 in / 21 out)',
      durationMs: 900,
      error: false,
      network: {
        kind: 'model',
        decision: 'allowed',
        method: 'POST',
        url: 'http://egress:8080/v1/chat/completions',
        host: null,
        port: null,
        server: null,
        status: 200,
        reason: null,
        model: 'mock/scripted',
        tokensIn: 1000,
        tokensOut: 21,
        forwardedTo: 'mock-model:8090',
      },
    });
    // No usage from the upstream: the entry is still there, without tokens.
    expect(bySeq(9)).toMatchObject({
      summary: 'mock/scripted · 200',
      network: {
        kind: 'model',
        status: 200,
        model: 'mock/scripted',
        tokensIn: null,
        tokensOut: null,
      },
    });
    // Refused at the gateway: never forwarded, no status, the reason kept.
    expect(bySeq(14)).toMatchObject({
      title: 'Model call refused',
      error: true,
      network: {
        kind: 'model',
        decision: 'denied',
        method: 'POST',
        url: 'http://egress:8080/v1/chat/completions',
        status: null,
        reason: 'token budget exhausted',
        model: null,
        forwardedTo: null,
      },
    });
  });

  it('gives every row from the log its entry, and no other row one', () => {
    const fromLog = shown.filter((e) => e.seq >= 8);
    expect(fromLog.map((e) => [e.seq, e.kind, e.network?.kind])).toEqual(
      expect.arrayContaining([
        [8, 'network', 'model'],
        [9, 'network', 'model'],
        [10, 'refused', 'connect'],
        [12, 'refused', 'http'],
        [13, 'network', 'mcp'],
        [14, 'network', 'model'],
      ]),
    );
    expect(fromLog).toHaveLength(6);
    // The refusal drawn on the terminal call (seq 11) is a sub-row, not an entry.
    expect(shown.filter((e) => e.kind !== 'network' && e.kind !== 'refused')).toSatisfy(
      (rows: TimelineEvent[]) => rows.every((e) => e.network === null),
    );
    expect(bySeq(4).network).toBeNull();
  });

  it("labels Hermes's background call and puts it on its own row", () => {
    expect(bySeq(10)).toMatchObject({
      kind: 'refused',
      origin: 'hermes-background',
      summary: 'inference-api.nousresearch.com:443',
      error: false,
      network: {
        kind: 'connect',
        decision: 'denied',
        method: null,
        url: null,
        host: 'inference-api.nousresearch.com',
        port: 443,
        server: null,
        status: null,
        reason: 'not on the allowlist',
        model: null,
        tokensIn: null,
        tokensOut: null,
        forwardedTo: null,
      },
      refusal: {
        host: 'inference-api.nousresearch.com',
        port: 443,
        reason: 'not on the allowlist',
      },
    });
  });

  it('draws a refusal during a tool call on that call, and one outside any call on its own', () => {
    const terminal = bySeq(4);
    expect(terminal.refusal).toEqual({
      host: 'example.com',
      port: 443,
      reason: 'not on the allowlist',
    });
    expect(shown.some((e) => e.seq === 11)).toBe(false);
    expect(bySeq(12)).toMatchObject({
      kind: 'refused',
      origin: 'agent',
      error: true,
      network: {
        kind: 'http',
        decision: 'denied',
        method: null,
        url: null,
        host: '10.0.0.5',
        port: 80,
        status: null,
        reason: 'private address',
      },
      refusal: { host: '10.0.0.5', port: 80, reason: 'private address' },
    });
  });

  it('tags an MCP gateway call with its server', () => {
    expect(bySeq(13)).toMatchObject({
      kind: 'network',
      title: 'MCP call',
      server: 'vendor-api',
      summary: 'vendor-api · 200',
      durationMs: 40,
      network: {
        kind: 'mcp',
        decision: 'allowed',
        method: null,
        url: 'http://egress:8080/mcp/vendor-api',
        host: 'vendor.example',
        port: null,
        server: 'vendor-api',
        status: 200,
        reason: null,
        model: null,
        tokensIn: null,
        tokensOut: null,
        forwardedTo: null,
      },
    });
  });

  it('pages by the events each row was built from', () => {
    expect(timelinePage(rows, 0, 14).events).toHaveLength(shown.length);
    const page = timelinePage(rows, 7, 14);
    // The terminal row comes again: a refusal was added to it after seq 7.
    expect(page.events.map((e) => e.seq).sort((a, b) => a - b)).toEqual([4, 8, 9, 10, 12, 13, 14]);
    expect(page.lastSeq).toBe(14);
    expect(timelinePage(rows, 14, 14)).toEqual({ events: [], lastSeq: 14 });
    expect(timelinePage(rows, 20, 14)).toEqual({ events: [], lastSeq: 20 });
  });
});

describe('a connection log stored by the worker', () => {
  // Entries as egress's admin socket reports them, stored through the
  // runner's own writer (networkEvents), then drawn.
  const at = (ms: number) => new Date(START + ms).toISOString();
  const log: EgressLogEntry[] = [
    { at: at(1_000), kind: 'connect', host: 'pypi.org', port: 443, decision: 'allowed', ms: 120 },
    {
      at: at(1_500),
      kind: 'http',
      host: 'example.com',
      port: 80,
      decision: 'allowed',
      status: 301,
    },
    {
      at: at(2_000),
      kind: 'mcp',
      server: 'invoice-db',
      method: 'POST',
      host: 'mcp.vendor.example',
      decision: 'allowed',
      status: 200,
      ms: 35,
    },
    {
      at: at(2_500),
      kind: 'mcp',
      server: 'invoice-db',
      method: 'POST',
      decision: 'denied',
      reason: 'too many calls in flight',
      status: 429,
    },
    {
      at: at(3_000),
      kind: 'model',
      model: 'mock/scripted',
      decision: 'allowed',
      status: 200,
      ms: 800,
      promptTokens: 1_200,
      completionTokens: 40,
    },
    {
      at: at(3_500),
      kind: 'model',
      model: 'mock/scripted',
      decision: 'denied',
      reason: 'token cap reached',
      status: 429,
    },
  ];
  const stored: EventRecord[] = networkEvents(log).map((e, i) => ({
    seq: i + 1,
    ts: e.ts,
    type: e.type,
    payload: e.payload,
  }));
  const shown = events(buildTimeline(stored, CTX));

  it('stores every entry as a network event', () => {
    expect(stored.map((e) => (e.payload as { subtype: string }).subtype)).toEqual(
      Array(6).fill('network'),
    );
  });

  it('fills the entry of each kind from what egress logged', () => {
    const bySeq = [...shown].sort((a, b) => a.seq - b.seq);
    expect(bySeq.map((e) => [e.seq, e.kind, e.network])).toEqual([
      [
        1,
        'network',
        expect.objectContaining({
          kind: 'connect',
          decision: 'allowed',
          method: null,
          url: null,
          host: 'pypi.org',
          port: 443,
          status: null,
        }),
      ],
      [
        2,
        'network',
        expect.objectContaining({
          kind: 'http',
          method: null,
          url: null,
          host: 'example.com',
          port: 80,
          status: 301,
        }),
      ],
      [
        3,
        'network',
        expect.objectContaining({
          kind: 'mcp',
          decision: 'allowed',
          method: 'POST',
          url: 'http://egress:8080/mcp/invoice-db',
          server: 'invoice-db',
          host: 'mcp.vendor.example',
          status: 200,
          model: null,
        }),
      ],
      [
        4,
        'network',
        expect.objectContaining({
          kind: 'mcp',
          decision: 'denied',
          server: 'invoice-db',
          status: 429,
          reason: 'too many calls in flight',
        }),
      ],
      [
        5,
        'network',
        {
          kind: 'model',
          decision: 'allowed',
          method: 'POST',
          url: 'http://egress:8080/v1/chat/completions',
          host: null,
          port: null,
          server: null,
          status: 200,
          reason: null,
          model: 'mock/scripted',
          tokensIn: 1_200,
          tokensOut: 40,
          forwardedTo: 'mock-model:8090',
        },
      ],
      [
        6,
        'network',
        expect.objectContaining({
          kind: 'model',
          decision: 'denied',
          status: 429,
          reason: 'token cap reached',
          model: 'mock/scripted',
          tokensIn: null,
          forwardedTo: null,
        }),
      ],
    ]);
  });

  it('reads a stored entry with missing or mistyped fields as nulls, never throwing', () => {
    const odd = buildTimeline(
      [
        network(1, START + 10, { kind: 'mcp', decision: 'allowed', port: 0, status: 42 }),
        network(2, START + 20, { kind: 'later', decision: 'maybe', host: 7 }),
      ],
      CTX,
    ).map((r) => TimelineEventSchema.parse(r.event));
    expect(odd[0]!.network).toMatchObject({ kind: 'mcp', url: null, port: null, status: null });
    expect(odd[1]!.network).toMatchObject({ kind: 'connect', decision: 'allowed', host: null });
  });
});

describe('a live attempt', () => {
  const sofar = recordedEvents().slice(0, 4);

  it('shows the open tool call as running, then completes it on the next page', () => {
    const open = events(buildTimeline(sofar, CTX)).at(-1)!;
    expect(open).toMatchObject({
      seq: 4,
      title: 'terminal',
      running: true,
      output: null,
      durationMs: null,
    });
    const later = timelinePage(buildTimeline(recordedEvents(), CTX), 4, 7);
    expect(later.events[0]).toMatchObject({ seq: 4, running: false, durationMs: 40 });
    expect(later.events.map((e) => e.seq)).toEqual([4, 6, 7]);
  });
});

describe('tool calls', () => {
  it('pairs parallel calls by tool_call_id and calls without one by name, oldest first', () => {
    const rows = events(
      buildTimeline(
        [
          line(1, {
            type: 'tool_use',
            name: 'read_file',
            tool_call_id: 'a',
            input: { path: 'a.csv' },
          }),
          line(2, {
            type: 'tool_use',
            name: 'read_file',
            tool_call_id: 'b',
            input: { path: 'b.csv' },
          }),
          line(3, { type: 'tool_result', name: 'read_file', tool_call_id: 'b', output: 'B' }),
          line(4, {
            type: 'tool_result',
            name: 'read_file',
            tool_call_id: 'a',
            output: 'A',
            is_error: true,
          }),
          line(5, { type: 'tool_use', name: 'terminal', input: { command: 'ls' } }),
          line(6, { type: 'tool_use', name: 'terminal', input: { command: 'pwd' } }),
          line(7, { type: 'tool_result', name: 'terminal', output: 'first' }),
          line(8, { type: 'tool_result', name: 'web_search', output: 'orphan' }),
        ],
        { ...CTX, mcpServers: [] },
      ),
    );
    expect(rows.map((e) => [e.seq, e.summary, e.output, e.error, e.running])).toEqual([
      [1, 'a.csv', 'A', true, false],
      [2, 'b.csv', 'B', false, false],
      [5, 'ls', 'first', false, false],
      [6, 'pwd', null, false, true],
      [8, '', 'orphan', false, false],
    ]);
    // No duration_ms in these results: measured from the two events' times.
    expect(rows[0]!.durationMs).toBe(300);
  });

  it('marks an output Hermes cut at 5,000 characters as truncated', () => {
    const cut = `${'x'.repeat(TOOL_OUTPUT_LIMIT)}...`;
    const [cutRow, wholeRow] = events(
      buildTimeline(
        [
          line(1, { type: 'tool_use', name: 'terminal', tool_call_id: '1', input: {} }),
          line(2, { type: 'tool_result', name: 'terminal', tool_call_id: '1', output: cut }),
          line(3, { type: 'tool_use', name: 'terminal', tool_call_id: '2', input: {} }),
          line(4, {
            type: 'tool_result',
            name: 'terminal',
            tool_call_id: '2',
            output: 'x'.repeat(TOOL_OUTPUT_LIMIT),
          }),
        ],
        CTX,
      ),
    );
    expect(cutRow).toMatchObject({ truncated: true, outputChars: TOOL_OUTPUT_LIMIT + 3 });
    expect(wholeRow).toMatchObject({ truncated: false, outputChars: TOOL_OUTPUT_LIMIT });
  });
});

describe('other rows', () => {
  it('draws a provider failure as a final response that failed', () => {
    const [row] = events(buildTimeline(recordedEvents([RECORDED_PROVIDER_FAILURE]), CTX));
    expect(row).toMatchObject({ kind: 'final', error: true, summary: 'error: Connection error.' });
    expect(row!.text).toMatch(/^custom didn't respond in time/);
  });

  it('draws stdout noise, unmapped events and the worker’s own events as platform rows', () => {
    const noise = parseStreamLine('Traceback (most recent call last):', START + 50);
    const unmapped = parseStreamLine('{"type":"thinking","text":"hmm"}', START + 60);
    const rows = events(
      buildTimeline(
        [
          { seq: 1, ts: noise.ts, type: noise.type, payload: noise.payload },
          { seq: 2, ts: unmapped.ts, type: unmapped.type, payload: unmapped.payload },
          {
            seq: 3,
            ts: START + 70,
            type: 'platform',
            payload: { type: 'platform', subtype: 'killed', message: 'Time budget 300 s reached' },
          },
          {
            seq: 4,
            ts: START + 80,
            type: 'platform',
            payload: { type: 'platform', subtype: 'collected', stderr_lines: 12 },
          },
        ],
        CTX,
      ),
    );
    expect(rows.map((e) => [e.title, e.summary, e.error])).toEqual([
      ['stdout', 'Traceback (most recent call last):', false],
      ['unmapped event', '{"type":"thinking","text":"hmm"}', false],
      ['killed', 'Time budget 300 s reached', true],
      ['collected', 'Workspace collected', false],
    ]);
    expect(rows.every((e) => e.kind === 'platform')).toBe(true);
  });

  it("describes the worker's own events from the fields the runner writes", () => {
    const platform = (seq: number, payload: Record<string, unknown>): EventRecord => ({
      seq,
      ts: START + seq * 10,
      type: 'platform',
      payload: { type: 'platform', ...payload } as never,
    });
    const rows = events(
      buildTimeline(
        [
          platform(1, {
            subtype: 'started',
            container_id: 'f3a9c1d2e4b5a6978877',
            network: 'hermes-evals-trial-2',
            image: 'hermes-evals/trial:v0.22.4-4d04303',
            deadline_ms: 180_000,
          }),
          platform(2, {
            subtype: 'killed',
            reason: 'disk_limit',
            detail: 'workspace 2.1 GB',
            signal: 'SIGKILL',
            exit_code: 137,
            after_ms: 41_200,
          }),
          platform(3, { subtype: 'cancelled', container_started: false }),
          platform(4, {
            subtype: 'collected',
            files: 3,
            stored: 2,
            stored_bytes: 900,
            too_large: ['big.bin'],
            agent_files: 2,
            not_collected: [{ path: 'link', kind: 'symlink' }],
            not_collected_count: 1,
            deleted_inputs: ['invoices.csv'],
            deleted_input_count: 1,
          }),
          platform(5, { subtype: 'worker_lost', message: 'Worker lost: heartbeat stopped.' }),
        ],
        CTX,
      ),
    );
    expect(rows.map((e) => [e.title, e.summary, e.text])).toEqual([
      [
        'started',
        'Trial container started on hermes-evals-trial-2',
        'image hermes-evals/trial:v0.22.4-4d04303 · network hermes-evals-trial-2 · container f3a9c1d2e4b5',
      ],
      [
        'killed',
        'Container stopped: disk cap passed · SIGKILL',
        'Container stopped: disk cap passed · workspace 2.1 GB · SIGKILL · exit 137 · after 41 s',
      ],
      ['cancelled', 'Run cancelled before its container started', null],
      [
        'collected',
        '3 files collected · 2 written by the agent · 1 not collected · 1 input deleted',
        'Listed without content (too large): big.bin\nNot collected: link\nInputs the agent deleted: invoices.csv',
      ],
      ['worker lost', 'Worker lost: heartbeat stopped.', 'Worker lost: heartbeat stopped.'],
    ]);
    expect(rows.map((e) => e.error)).toEqual([false, true, false, false, true]);
  });

  it("adds the home's memory files to the collected row (Phase 6 P2)", () => {
    const collected = (payload: Record<string, unknown>): EventRecord => ({
      seq: 1,
      ts: START + 10,
      type: 'platform',
      payload: {
        type: 'platform',
        subtype: 'collected',
        files: 1,
        agent_files: 0,
        ...payload,
      } as never,
    });
    const [kept, failed] = [
      collected({
        home_files: 2,
        home_agent_files: 1,
        home_not_collected: [{ path: 'home/memories/link', kind: 'symlink' }],
        home_not_collected_count: 1,
        deleted_home_seeds: ['home/memories/USER.md'],
      }),
      collected({ home_files: 0, home_error: 'EACCES: permission denied' }),
    ].map((e) => events(buildTimeline([e], CTX))[0]);
    expect([kept?.summary, kept?.text]).toEqual([
      '1 file collected · 0 written by the agent · 2 memory files',
      'Not collected from the home: home/memories/link\nMemory seeds the agent deleted: home/memories/USER.md',
    ]);
    expect([failed?.summary, failed?.text]).toEqual([
      '1 file collected · 0 written by the agent',
      'The memory files could not be collected: EACCES: permission denied',
    ]);
  });

  it('marks a result the worker recorded itself', () => {
    const [row] = events(
      buildTimeline(
        [
          line(1, {
            type: 'result',
            synthesized: true,
            exit_code: null,
            text: '',
            error: 'timeout',
            timestamp: START + 310_000,
          }),
        ],
        CTX,
      ),
    );
    expect(row).toMatchObject({
      title: 'result (recorded by the worker)',
      atMs: 310_000,
      error: true,
    });
  });
});

describe('Phase 7', () => {
  const toolRun = (name: string, output: string) =>
    events(
      buildTimeline(
        [
          line(1, { type: 'tool_use', name, tool_call_id: 'c1', input: {} }),
          line(2, { type: 'tool_result', name, tool_call_id: 'c1', output }),
        ],
        CTX,
      ),
    )[0]!;
  const MCP_TOOL = 'mcp__invoice_db__list_invoices';

  it('keeps 20,000 characters of an MCP result and 5,000 of any other tool’s output', () => {
    const page = 'p'.repeat(7_000);
    expect(toolRun(MCP_TOOL, page)).toMatchObject({
      server: 'invoice-db',
      output: page,
      outputChars: 7_000,
      truncated: false,
    });
    const huge = toolRun(MCP_TOOL, 'q'.repeat(25_000));
    expect(huge).toMatchObject({ outputChars: 25_000, truncated: true });
    expect(huge.output).toHaveLength(20_000);
    const terminal = toolRun('terminal', 't'.repeat(7_000));
    expect(terminal).toMatchObject({ server: null, outputChars: 7_000, truncated: true });
    expect(terminal.output).toHaveLength(TOOL_OUTPUT_LIMIT);
  });

  it('still marks an MCP result Hermes’s emitter cut at 5,000 characters', () => {
    const cut = `${'r'.repeat(TOOL_OUTPUT_LIMIT)}...`;
    expect(toolRun(MCP_TOOL, cut)).toMatchObject({
      output: cut,
      outputChars: TOOL_OUTPUT_LIMIT + 3,
      truncated: true,
    });
    expect(toolRun(MCP_TOOL, 'short...')).toMatchObject({ truncated: false });
  });

  const one = (fields: Record<string, unknown>) =>
    events(buildTimeline([network(1, START + 1_000, fields)], CTX))[0]!;

  it('draws a request egress labelled as Hermes background neutral, from its origin', () => {
    const refused = one({
      kind: 'connect',
      host: 'hermes-agent.nousresearch.com',
      port: 443,
      decision: 'denied',
      reason: 'host is not on the allowlist',
      origin: 'hermes_background',
      background: true,
    });
    expect(refused).toMatchObject({ kind: 'refused', origin: 'hermes-background', error: false });
    const allowed = one({
      kind: 'connect',
      host: 'raw.githubusercontent.com',
      port: 443,
      decision: 'allowed',
      status: 404,
      origin: 'hermes_background',
      background: true,
    });
    expect(allowed).toMatchObject({ kind: 'network', origin: 'hermes-background', error: false });
    // The origin wins over a contradicting flag; an event stored before Phase 7 has only the flag.
    expect(
      one({
        kind: 'connect',
        host: 'a.example',
        port: 443,
        decision: 'denied',
        origin: 'agent',
        background: true,
      }).origin,
    ).toBe('agent');
    expect(
      one({
        kind: 'connect',
        host: 'inference-api.nousresearch.com',
        port: 443,
        decision: 'denied',
        background: true,
      }),
    ).toMatchObject({ kind: 'refused', origin: 'hermes-background', error: false });
  });

  it('draws the 405 a server answers the MCP client’s GET with as a neutral row', () => {
    const declined = one({
      kind: 'mcp',
      server: 'vendor-directory',
      method: 'GET',
      host: 'vendor-directory',
      port: 8000,
      decision: 'allowed',
      status: 405,
      ms: 4,
    });
    expect(declined).toMatchObject({
      kind: 'network',
      title: 'MCP event stream not offered',
      summary: 'vendor-directory · 405',
      server: 'vendor-directory',
      origin: 'agent',
      error: false,
    });
    expect(declined.text).toContain('answered the MCP client');
    // A 405 to a POST is still a failed call, and so is a refused GET.
    expect(
      one({
        kind: 'mcp',
        server: 'vendor-directory',
        method: 'POST',
        decision: 'allowed',
        status: 405,
      }),
    ).toMatchObject({ title: 'MCP call', error: true });
    expect(
      one({
        kind: 'mcp',
        server: 'x',
        method: 'GET',
        decision: 'denied',
        status: 405,
        reason: 'GET',
      }),
    ).toMatchObject({ title: 'MCP call', error: true });
  });
});
