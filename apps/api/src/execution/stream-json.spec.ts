import { describe, expect, it } from 'vitest';
import { RunEventPayloadSchema, TokensSchema } from '@hermes-evals/shared';
import {
  hermesMcpToolName,
  NOISE_LINE_MAX_CHARS,
  parseMcpToolName,
  parseStreamLine,
  resultTokens,
  sanitizeMcpNameComponent,
} from './stream-json.js';

/**
 * Lines recorded from the real Hermes (trial image hermes-evals/trial:v0.22.4-4d04303,
 * revision 4d04303) on 24 Oct 2026: `hermes chat --oneshot --format stream-json
 * --provider custom` in a container with no network, against a scripted
 * OpenAI-compatible model inside the same container, with the baked-in
 * invoice-db stdio MCP server configured. No login, no real provider. The
 * model asked for invoice-db's get_invoice through Hermes's tool_call bridge,
 * then the terminal, then answered; its three calls reported 1,000, 1,100 and
 * 1,200 prompt tokens with 0, 400 and 800 of them cached.
 */
const RECORDED_RUN: readonly string[] = [
  '{"type": "system", "subtype": "init", "model": "mock/scripted", "session_id": "", "timestamp": 1792856095707}',
  '{"type": "tool_use", "name": "mcp__invoice_db__get_invoice", "tool_call_id": "call_0", "input": {"invoice_no": "INV-1001"}, "timestamp": 1792856101405}',
  '{"type": "tool_result", "name": "mcp__invoice_db__get_invoice", "tool_call_id": "call_0", "output": "{\\"result\\": \\"{\\\\n  \\\\\\"invoice_no\\\\\\": \\\\\\"INV-1001\\\\\\",\\\\n  \\\\\\"vendor_name\\\\\\": \\\\\\"Acme Supplies\\\\\\",\\\\n  \\\\\\"invoice_date\\\\\\": \\\\\\"2026-09-01\\\\\\",\\\\n  \\\\\\"due_date\\\\\\": \\\\\\"2026-10-01\\\\\\",\\\\n  \\\\\\"amount\\\\\\": 1250.0,\\\\n  \\\\\\"currency\\\\\\": \\\\\\"EUR\\\\\\",\\\\n  \\\\\\"po_number\\\\\\": \\\\\\"PO-501\\\\\\",\\\\n  \\\\\\"status\\\\\\": \\\\\\"paid\\\\\\"\\\\n}\\"}", "duration_ms": 7, "is_error": false, "timestamp": 1792856101412}',
  '{"type": "tool_use", "name": "terminal", "tool_call_id": "call_1", "input": {"command": "echo hello > /tmp/ws/out.txt && cat /tmp/ws/out.txt"}, "timestamp": 1792856101427}',
  '{"type": "tool_result", "name": "terminal", "tool_call_id": "call_1", "output": "{\\"output\\": \\"hello\\", \\"exit_code\\": 0, \\"error\\": null}", "duration_ms": 40, "is_error": false, "timestamp": 1792856101468}',
  '{"type": "text", "text": "\\n\\nTotal done.\\n```json\\n{\\"total\\": 1042}\\n```", "timestamp": 1792856101472}',
  '{"type": "result", "session_id": "local-f6da07ee3ed16bbdcd806ce8eca2ad19202848887fc6edbdeea8291ccf97119b", "exit_code": 0, "text": "Total done.\\n```json\\n{\\"total\\": 1042}\\n```", "tokens": {"input": 3300, "output": 63, "total": 3363, "cache_read": 1200, "cache_write": 0}, "duration_ms": 5789, "timestamp": 1792856101496}',
];

/** The same run with the model unreachable: Hermes retried for 304 s, then gave up. */
const RECORDED_PROVIDER_FAILURE =
  '{"type": "result", "session_id": "local-d994ca8d9d23f8eba268cff6ad647d3ba39a3d3aa5d8e87d2349c077f3a13af0", "exit_code": 1, "text": "custom didn\'t respond in time on any of 3 attempts — it looks temporarily unavailable. Wait a minute and send /retry, or switch models with /model. To avoid this in future, add a backup provider with `hermes fallback add`.\\n\\nProvider said: Connection error.\\n\\nYour request was not processed. Send it again if you still want me to carry it out.", "tokens": {"input": 0, "output": 0, "total": 0, "cache_read": 0, "cache_write": 0}, "duration_ms": 303856, "error": "Connection error.", "timestamp": 1792856407701}';

const RECEIVED_AT = 1_792_856_200_000;

describe('parseStreamLine on the recorded run', () => {
  const events = RECORDED_RUN.map((line) => parseStreamLine(line, RECEIVED_AT));

  it('maps every Hermes line to its own type, keeping every field and the event time', () => {
    expect(events.map((e) => e.type)).toEqual([
      'system',
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result',
      'text',
      'result',
    ]);
    for (const [index, event] of events.entries()) {
      const raw = JSON.parse(RECORDED_RUN[index]!) as { timestamp: number };
      expect(event.payload).toEqual(raw);
      expect(event.ts).toBe(raw.timestamp);
      expect(RunEventPayloadSchema.parse(event.payload)).toEqual(event.payload);
      expect(event.payload.type).toBe(event.type);
    }
  });

  it('keeps the answer in the result, not in the streamed text', () => {
    const field = (index: number, key: string): unknown =>
      (events[index]!.payload as Record<string, unknown>)[key];
    expect(field(6, 'text')).toBe('Total done.\n```json\n{"total": 1042}\n```');
    expect(field(5, 'text')).not.toBe(field(6, 'text'));
    expect(field(6, 'session_id')).toMatch(/^local-/);
    expect(field(0, 'session_id')).toBe('');
  });
});

describe('parseStreamLine on untrusted lines', () => {
  it('stores a line that is not a JSON object as noise, cut at the cap', () => {
    for (const line of ['Traceback (most recent call last):', '42', '"text"', '[1, 2]', 'null']) {
      expect(parseStreamLine(line, RECEIVED_AT)).toEqual({
        ts: RECEIVED_AT,
        type: 'platform',
        payload: { type: 'platform', subtype: 'noise', line },
      });
    }
    const long = 'x'.repeat(NOISE_LINE_MAX_CHARS + 5);
    const event = parseStreamLine(long, RECEIVED_AT);
    expect(event.payload).toEqual({
      type: 'platform',
      subtype: 'noise',
      line: 'x'.repeat(NOISE_LINE_MAX_CHARS),
      truncated: true,
      chars: NOISE_LINE_MAX_CHARS + 5,
    });
  });

  it('stores an unknown type, a forged platform event or a malformed Hermes event as unmapped', () => {
    for (const raw of [
      { type: 'thinking', text: 'hmm', timestamp: 5 },
      { type: 'platform', subtype: 'collected', timestamp: 5 },
      { type: 'text', timestamp: 5 },
      { type: 'tool_use', name: 7, timestamp: 5 },
      { text: 'no type', timestamp: 5 },
    ]) {
      const event = parseStreamLine(JSON.stringify(raw), RECEIVED_AT);
      expect(event).toEqual({
        ts: 5,
        type: 'platform',
        payload: { type: 'platform', subtype: 'unmapped', event: raw },
      });
      expect(RunEventPayloadSchema.safeParse(event.payload).success).toBe(true);
    }
  });

  it('uses the receipt time when the event has no usable timestamp', () => {
    for (const timestamp of [undefined, 'soon', -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const line = JSON.stringify({ type: 'text', text: 'hi', timestamp });
      expect(parseStreamLine(line, RECEIVED_AT).ts).toBe(RECEIVED_AT);
    }
  });
});

describe('resultTokens', () => {
  it('reads the recorded result: input counts the cached prompt tokens too', () => {
    const tokens = resultTokens(JSON.parse(RECORDED_RUN.at(-1)!));
    expect(tokens).toEqual({
      input: 3300,
      output: 63,
      total: 3363,
      cache_read: 1200,
      cache_write: 0,
    });
    expect(TokensSchema.parse(tokens)).toEqual(tokens);
  });

  it('reads a failed run as zero tokens, not as unknown', () => {
    expect(resultTokens(JSON.parse(RECORDED_PROVIDER_FAILURE))).toEqual({
      input: 0,
      output: 0,
      total: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it('fills a count Hermes left out with 0, as its emitter does', () => {
    expect(resultTokens({ type: 'result', tokens: { input: 10, output: 2, total: 12 } })).toEqual({
      input: 10,
      output: 2,
      total: 12,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it('is null for anything else, and for a count it cannot trust', () => {
    for (const event of [
      null,
      'result',
      { type: 'text', tokens: { input: 1 } },
      { type: 'result' },
      { type: 'result', tokens: [1, 2] },
      { type: 'result', tokens: { input: -1, output: 0, total: 0 } },
      { type: 'result', tokens: { input: 1.5, output: 0, total: 0 } },
      { type: 'result', tokens: { input: '12', output: 0, total: 0 } },
    ]) {
      expect(resultTokens(event), JSON.stringify(event)).toBeNull();
    }
  });
});

describe('MCP tool names', () => {
  it('names a tool the way Hermes registered the recorded one', () => {
    expect(hermesMcpToolName('invoice-db', 'get_invoice')).toBe('mcp__invoice_db__get_invoice');
    expect(sanitizeMcpNameComponent('a.b-c d')).toBe('a_b_c_d');
  });

  it('matches Hermes on long and non-ASCII names', () => {
    // Expected values printed by mcp_prefixed_tool_name in the trial image.
    expect(
      hermesMcpToolName('a-very-long-server-name-for-testing', 'an_equally_long_tool_name_here'),
    ).toBe('mcp__a_very_long_server_name_for_testing__an_equally_lo_a88c8aa9');
    expect(hermesMcpToolName('x'.repeat(70), 'tööl.ü')).toBe(`mcp__${'x'.repeat(50)}_a34bf0ff`);
    expect(hermesMcpToolName('srv', 'look\u{1F600}up')).toBe('mcp__srv__look_up');
  });

  it('attributes the recorded tool events to their configured server', () => {
    const events = RECORDED_RUN.map((line) => JSON.parse(line) as { type: string; name?: string });
    const tools = events.filter((e) => e.type === 'tool_use' || e.type === 'tool_result');
    expect(tools.map((e) => parseMcpToolName(e.name!, ['invoice-db']))).toEqual([
      { server: 'invoice-db', tool: 'get_invoice' },
      { server: 'invoice-db', tool: 'get_invoice' },
      null,
      null,
    ]);
  });

  it('picks the longest configured name, which the sanitized part alone cannot tell', () => {
    const name = hermesMcpToolName('db__admin', 'drop');
    expect(name).toBe('mcp__db__admin__drop');
    expect(parseMcpToolName(name, ['db', 'db__admin'])).toEqual({
      server: 'db__admin',
      tool: 'drop',
    });
    expect(parseMcpToolName(name, ['db'])).toEqual({ server: 'db', tool: 'admin__drop' });
    expect(parseMcpToolName(name)).toEqual({ server: 'db', tool: 'admin__drop' });
    expect(parseMcpToolName(name, ['other'])).toBeNull();
  });

  it('is null for built-in tools and malformed names', () => {
    for (const name of [
      'terminal',
      'tool_call',
      'mcp__',
      'mcp__server',
      'mcp__server__',
      'mcp____x',
    ]) {
      expect(parseMcpToolName(name), name).toBeNull();
    }
    expect(parseMcpToolName('mcp__invoice_db__', ['invoice-db'])).toBeNull();
  });
});
