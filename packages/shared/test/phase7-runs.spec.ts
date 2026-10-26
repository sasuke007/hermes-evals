/**
 * Phase 7's contracts for runs and MCP servers: the whole stderr.log
 * (Phase 5 section 6.1), json_match evidence key by key, Hermes's background
 * requests with an origin of their own (Phase 5 question 19), the MCP
 * timeline window (Phase 6 question 13) and an http header's prefix (Phase 6
 * question 6).
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_STDERR_MAX_BYTES,
  AttemptStderrParamsSchema,
  AttemptStderrSchema,
  canonicalMcpHeaders,
  HERMES_BACKGROUND_HOSTS,
  isHermesBackgroundHost,
  JsonMatchEvidenceSchema,
  McpHeaderSchema,
  McpServerInputSchema,
  McpServerRefSchema,
  NETWORK_ORIGINS,
  NetworkEventPayloadSchema,
  RunEventPayloadSchema,
  ScoreEvidenceSchema,
  ScoreEvidenceViewSchema,
  TIMELINE_ORIGIN_OF,
  TIMELINE_ORIGINS,
  TIMELINE_OUTPUT_LIMITS,
  TimelineEventSchema,
  timelineOutputLimit,
  type McpServerInput,
} from '../src/index.js';

describe('the whole stderr.log (GET /runs/:id/attempts/:n/stderr)', () => {
  const log = {
    runId: '01JRUN',
    attempt: 2,
    text: 'Traceback (most recent call last):\n  File "run_agent.py"\nTimeoutError\n',
    sizeBytes: 66,
    totalLines: 3,
    truncated: false,
  };

  it('answers the log as text, whole or its end, and says which', () => {
    expect(AttemptStderrSchema.parse(log)).toEqual(log);
    expect(AttemptStderrSchema.parse({ ...log, text: '', sizeBytes: 0, totalLines: 0 }).text).toBe(
      '',
    );
    const long = { ...log, sizeBytes: ATTEMPT_STDERR_MAX_BYTES + 1, truncated: true };
    expect(AttemptStderrSchema.parse(long).truncated).toBe(true);
    expect(AttemptStderrSchema.safeParse({ ...long, truncated: false }).success).toBe(false);
    expect(AttemptStderrSchema.safeParse({ ...log, truncated: true }).success).toBe(false);
    expect(AttemptStderrSchema.safeParse({ ...log, attempt: 0 }).success).toBe(false);
  });

  it('takes the attempt number from the route, from 1', () => {
    expect(AttemptStderrParamsSchema.parse({ id: '01JRUN', n: '3' })).toEqual({
      id: '01JRUN',
      n: 3,
    });
    for (const n of ['0', '-1', '1.5', 'x']) {
      expect(AttemptStderrParamsSchema.safeParse({ id: '01JRUN', n }).success, n).toBe(false);
    }
  });
});

describe('json_match evidence key by key', () => {
  const before = { unit: 'keys', matched: 4, total: 5, mismatches: ['Granite Office'] };
  const keyByKey = {
    ...before,
    path: 'overdue_by_vendor',
    entries: [
      { path: 'Fjord Software', expected: 3, observed: 3, match: true },
      { path: 'Granite Office', expected: 2, observed: 3, match: false },
      { path: 'Helios Energy', expected: 4, observed: 4, match: true },
      { path: 'Cobalt Print Co', expected: 1, observed: 1, match: true },
      { path: 'Nordlys Freight', expected: 7, observed: 7, match: true },
    ],
  };

  it('keeps reading rows stored before Phase 7', () => {
    expect(JsonMatchEvidenceSchema.parse(before)).toEqual(before);
    expect(ScoreEvidenceSchema.parse({ json_match: before }).json_match?.entries).toBeUndefined();
  });

  it('lists every key with both values and the compared path', () => {
    const parsed = JsonMatchEvidenceSchema.parse(keyByKey);
    expect(parsed.path).toBe('overdue_by_vendor');
    expect(parsed.entries?.filter((e) => !e.match).map((e) => e.path)).toEqual(['Granite Office']);
    expect(JsonMatchEvidenceSchema.parse({ ...before, path: null, entries: [] }).path).toBeNull();
    const view = {
      eventSeqs: [],
      artifactIds: [],
      judge: null,
      trajectory: null,
      text: null,
      jsonMatch: keyByKey,
    };
    expect(ScoreEvidenceViewSchema.parse(view).jsonMatch?.entries).toHaveLength(5);
  });

  it('marks a side with no value there by leaving it out, never by null', () => {
    const answerOnly = { path: '[3]', observed: { invoice: 'INV-9' }, match: false };
    const missing = { path: 'Nordlys Freight', expected: 7, match: false };
    const nullValue = { path: 'note', expected: null, observed: null, match: true };
    const parsed = JsonMatchEvidenceSchema.parse({
      ...before,
      entries: [answerOnly, missing, nullValue],
    });
    expect(parsed.entries?.[0]).not.toHaveProperty('expected');
    expect(parsed.entries?.[2]?.expected).toBeNull();
    expect(
      JsonMatchEvidenceSchema.safeParse({ ...before, entries: [{ path: 'a', expected: 1 }] })
        .success,
    ).toBe(false);
  });
});

describe("Hermes's background requests", () => {
  const entry = {
    type: 'platform',
    subtype: 'network',
    kind: 'connect',
    host: 'hermes-agent.nousresearch.com',
    port: 443,
    decision: 'denied',
    reason: 'not on the allowlist',
  } as const;

  it('labels egress entries with an origin, and reads entries stored without one', () => {
    expect(NETWORK_ORIGINS).toEqual(['agent', 'hermes_background']);
    const labelled = { ...entry, background: true, origin: 'hermes_background' };
    expect(NetworkEventPayloadSchema.parse(labelled).origin).toBe('hermes_background');
    expect(RunEventPayloadSchema.parse(labelled)).toEqual(labelled);
    expect(NetworkEventPayloadSchema.parse({ ...entry, background: false }).origin).toBeUndefined();
    expect(
      NetworkEventPayloadSchema.safeParse({ ...labelled, origin: 'hermes-background' }).success,
    ).toBe(false);
  });

  it('knows the hosts Hermes contacts by itself, in any case', () => {
    expect(HERMES_BACKGROUND_HOSTS).toEqual([
      'inference-api.nousresearch.com',
      'hermes-agent.nousresearch.com',
      'raw.githubusercontent.com',
    ]);
    expect(isHermesBackgroundHost('Raw.GitHubUserContent.com')).toBe(true);
    expect(isHermesBackgroundHost('api.github.com')).toBe(false);
    expect(isHermesBackgroundHost('nousresearch.com')).toBe(false);
  });

  it("draws a stored origin with the timeline's spelling", () => {
    expect(TIMELINE_ORIGINS).toEqual(['agent', 'hermes-background']);
    expect(NETWORK_ORIGINS.map((o) => TIMELINE_ORIGIN_OF[o])).toEqual(TIMELINE_ORIGINS);
    const row = {
      seq: 41,
      kind: 'refused',
      origin: TIMELINE_ORIGIN_OF.hermes_background,
      atMs: 1200,
      title: 'Refused by sandbox',
      server: null,
      summary: 'hermes-agent.nousresearch.com:443',
      durationMs: null,
      error: false,
      running: false,
      input: null,
      output: null,
      outputChars: null,
      truncated: false,
      text: null,
      network: {
        kind: 'connect',
        decision: 'denied',
        method: null,
        url: null,
        host: 'hermes-agent.nousresearch.com',
        port: 443,
        server: null,
        status: null,
        reason: 'not on the allowlist',
        model: null,
        tokensIn: null,
        tokensOut: null,
        forwardedTo: null,
      },
      refusal: { host: 'hermes-agent.nousresearch.com', port: 443, reason: 'not on the allowlist' },
    };
    expect(TimelineEventSchema.parse(row).origin).toBe('hermes-background');
    expect(TimelineEventSchema.safeParse({ ...row, origin: 'hermes_background' }).success).toBe(
      false,
    );
  });
});

describe("the timeline's output windows", () => {
  it('keeps 20,000 characters of an MCP result and 5,000 of any other tool output', () => {
    expect(TIMELINE_OUTPUT_LIMITS).toEqual({ tool: 5_000, mcp: 20_000 });
    expect(timelineOutputLimit({ server: 'invoice_db' })).toBe(20_000);
    expect(timelineOutputLimit({ server: null })).toBe(5_000);
  });
});

describe("an http MCP header's prefix", () => {
  const http: McpServerInput = {
    name: 'vendor-directory',
    transport: 'http',
    command: null,
    args: [],
    envNames: [],
    url: 'http://vendor-directory:8000/mcp',
    headers: [{ header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN', prefix: 'Bearer ' }],
    include: [],
    exclude: [],
    timeoutS: 60,
  };

  it('accepts a printable prefix such as "Bearer ", and none at all', () => {
    expect(McpServerInputSchema.parse(http).headers[0]?.prefix).toBe('Bearer ');
    const plain = { header: 'X-Api-Key', env: 'VENDOR_API_KEY' };
    expect(McpHeaderSchema.parse(plain)).toEqual(plain);
    expect(McpServerInputSchema.parse({ ...http, headers: [plain] }).headers[0]).not.toHaveProperty(
      'prefix',
    );
    expect(McpServerRefSchema.shape.headers.parse(http.headers)).toEqual(http.headers);
  });

  it('refuses an empty prefix, a line break, a control character and more than 64 characters', () => {
    for (const prefix of ['', 'Bearer\r\nX-Evil: 1', 'Bearer\t', 'Bearer\u0000', 'x'.repeat(65)]) {
      const header = { header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN', prefix };
      expect(McpHeaderSchema.safeParse(header).success, JSON.stringify(prefix)).toBe(false);
    }
    expect(
      McpHeaderSchema.safeParse({ header: 'A', env: 'B', prefix: 'x'.repeat(64) }).success,
    ).toBe(true);
  });

  it('hashes a pair without a prefix exactly as before prefixes existed, and a prefix as a change', () => {
    const headers = [
      { header: 'X-Trace', env: 'TRACE_ID' },
      { header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN' },
    ];
    // definitionHash's form before Phase 7: lower-cased names, sorted, { header, env } only.
    const before = headers
      .map((h) => ({ header: h.header.toLowerCase(), env: h.env }))
      .sort((a, b) => (a.header < b.header ? -1 : 1));
    expect(JSON.stringify(canonicalMcpHeaders(headers))).toBe(JSON.stringify(before));
    const prefixed = canonicalMcpHeaders([{ ...headers[1]!, prefix: 'Bearer ' }, headers[0]!]);
    expect(prefixed).toEqual([
      { header: 'authorization', env: 'VENDOR_DIRECTORY_TOKEN', prefix: 'Bearer ' },
      { header: 'x-trace', env: 'TRACE_ID' },
    ]);
    expect(JSON.stringify(prefixed)).not.toBe(JSON.stringify(before));
  });
});
