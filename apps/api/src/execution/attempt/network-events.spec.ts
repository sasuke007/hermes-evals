import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HERMES_BACKGROUND_HOSTS, NetworkEventPayloadSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import type { EgressLogEntry } from '../../sandbox/egress-client.js';
import { networkEvents, networkOrigin, networkPayload } from './network-events.js';

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
    expect(networkPayload(mcp)).toEqual({
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
      origin: 'agent',
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
    expect(networkPayload(model)).toMatchObject({ tokens_in: 1000, tokens_out: 21 });
    expect(NetworkEventPayloadSchema.safeParse(networkPayload(model)).success).toBe(true);
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
    const payload = networkPayload(odd);
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

describe('origin (Phase 7)', () => {
  const entry = (over: Record<string, unknown>) =>
    ({ at: AT, kind: 'connect', port: 443, decision: 'denied', ...over }) as EgressLogEntry;

  it('keeps the origin egress labelled a proxy entry with, and background with it', () => {
    const payload = networkPayload(
      entry({ host: 'inference-api.nousresearch.com', origin: 'hermes_background' }),
    );
    expect(payload).toMatchObject({ origin: 'hermes_background', background: true });
    expect(NetworkEventPayloadSchema.parse(payload).origin).toBe('hermes_background');
    expect(networkPayload(entry({ host: 'example.com', origin: 'agent' }))).toMatchObject({
      origin: 'agent',
      background: false,
    });
  });

  it('labels an entry egress did not by host, on every provider, in any case', () => {
    for (const host of [
      ...HERMES_BACKGROUND_HOSTS,
      'RAW.githubusercontent.com',
      'hermes-agent.nousresearch.com.',
    ]) {
      expect(networkOrigin(entry({ host })), host).toBe('hermes_background');
      expect(networkOrigin(entry({ host, kind: 'http' })), host).toBe('hermes_background');
    }
    for (const host of ['portal.nousresearch.com', 'githubusercontent.com', undefined]) {
      expect(networkOrigin(entry({ host })), String(host)).toBe('agent');
    }
    // A label egress never writes is read by host.
    expect(networkOrigin(entry({ host: 'raw.githubusercontent.com', origin: 'nope' }))).toBe(
      'hermes_background',
    );
  });

  it('counts the model and MCP gateways’ calls as the agent’s, whatever their host', () => {
    const mcp = entry({ kind: 'mcp', server: 'x', host: 'raw.githubusercontent.com' });
    expect(networkPayload(mcp)).toMatchObject({ origin: 'agent', background: false });
    expect(networkOrigin(entry({ kind: 'model', origin: 'hermes_background' }))).toBe('agent');
  });

  it('agrees with egress’s own copy of the background hosts', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../../../../egress/src/background.ts'),
      'utf8',
    );
    const list = /HERMES_BACKGROUND_HOSTS: readonly string\[\] = \[([^\]]*)\]/.exec(source)?.[1];
    expect(list, 'egress background.ts lists the hosts').toBeDefined();
    const hosts = [...list!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(hosts).toEqual([...HERMES_BACKGROUND_HOSTS]);
  });
});
