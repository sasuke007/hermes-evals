import { NetworkEventPayloadSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import type { EgressLogEntry } from '../../sandbox/egress-client.js';
import { networkEvents, networkPayload } from './network-events.js';

const AT = '2026-10-24T12:00:00.000Z';

describe('networkPayload', () => {
  it('keeps an MCP call method and a model call tokens when egress logs them', () => {
    const mcp = {
      at: AT,
      kind: 'mcp',
      server: 'vendor',
      method: 'POST',
      host: 'vendor.example',
      port: 443,
      decision: 'allowed',
      status: 200,
      ms: 40,
    } as EgressLogEntry;
    expect(networkPayload(mcp, 'custom')).toEqual({
      type: 'platform',
      subtype: 'network',
      kind: 'mcp',
      host: 'vendor.example',
      port: 443,
      decision: 'allowed',
      status: 200,
      ms: 40,
      server: 'vendor',
      method: 'POST',
      background: false,
    });

    const model = {
      at: AT,
      kind: 'model',
      model: 'mock/scripted',
      decision: 'allowed',
      status: 200,
      promptTokens: 1000,
      completionTokens: 21,
    } as EgressLogEntry;
    expect(networkPayload(model, 'custom')).toMatchObject({ tokens_in: 1000, tokens_out: 21 });
    expect(NetworkEventPayloadSchema.safeParse(networkPayload(model, 'custom')).success).toBe(true);
  });

  it('drops a method that is not one, half a token pair, and impossible numbers', () => {
    const odd = {
      at: AT,
      kind: 'model',
      decision: 'allowed',
      method: 'post /x',
      port: 70_000,
      status: -1,
      promptTokens: 5,
    } as EgressLogEntry;
    const payload = networkPayload(odd, 'custom');
    expect(payload).not.toHaveProperty('method');
    expect(payload).not.toHaveProperty('tokens_in');
    expect(payload).not.toHaveProperty('port');
    expect(payload).not.toHaveProperty('status');
  });
});

describe('networkEvents', () => {
  it('times each event by its log entry, and keeps one that does not fit as unmapped', () => {
    const events = networkEvents(
      [
        { at: AT, kind: 'connect', host: 'example.com', port: 443, decision: 'denied' },
        { at: 'later', kind: 'telepathy', decision: 'allowed' } as unknown as EgressLogEntry,
      ],
      'custom',
      42,
    );
    expect(events[0]).toMatchObject({ ts: Date.parse(AT), type: 'platform' });
    expect(events[1]).toEqual({
      ts: 42,
      type: 'platform',
      payload: {
        type: 'platform',
        subtype: 'unmapped',
        source: 'egress',
        event: { at: 'later', kind: 'telepathy', decision: 'allowed' },
      },
    });
  });
});
