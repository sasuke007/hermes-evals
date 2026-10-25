/**
 * The judge's wire contract, egress's half (Phase 3 S2). The worker's
 * client parses what this path answers with strict schemas, and egress does
 * not depend on the shared package, so both halves are held to one set of
 * example messages: packages/shared/fixtures/egress-judge-wire.json. Here the
 * real admin socket must accept the worker's example requests and answer in
 * the examples' shape; apps/api/src/sandbox/egress-judge-wire.spec.ts holds
 * the worker's half to the same file.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminServer } from '../src/admin.js';
import { JudgeRegistrationSchema, JudgeRegistry } from '../src/judge-registry.js';
import { Registry } from '../src/registry.js';

interface Wire {
  register: { named: Record<string, unknown>; custom: Record<string, unknown> };
  complete: {
    request: Record<string, unknown>;
    answered: { status: number; body: unknown; usage: unknown };
    unmetered: { status: number; body: unknown; usage: unknown };
    refused: { status: number; body: unknown };
  };
  remove: { usage: unknown; log: unknown[] };
}

const WIRE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../packages/shared/fixtures/egress-judge-wire.json', import.meta.url),
    ),
    'utf8',
  ),
) as Wire;

/**
 * A value's shape: its keys, all the way down, and each leaf's JSON type.
 * The contract is the shape; the values are the examples' own.
 */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
}

const JUDGE = '01K8ZQ7M3V5X9C2B4N6P8R0W01';
let upstreamStatus = 200;

/** Answers as the example: the answered body with its usage, or the unmetered error. */
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const body =
      upstreamStatus === 200 ? WIRE.complete.answered.body : WIRE.complete.unmetered.body;
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'egress-judge-wire-'));
const socket = join(dir, 'admin.sock');
const judges = new JudgeRegistry();
const admin = createAdminServer(new Registry(), {
  judges: { judges, upstreams: {}, env: () => ({}) },
});
let upstreamUrl = '';

beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => admin.listen(socket, r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
  upstream.close();
  admin.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(method: string, path: string, body?: unknown) {
  return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }),
      );
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe('the judge wire contract, egress side', () => {
  it('accepts both example registrations as the worker sends them', () => {
    for (const example of [WIRE.register.named, WIRE.register.custom]) {
      expect(JudgeRegistrationSchema.safeParse(example).success).toBe(true);
    }
  });

  it('answers the example request in the examples’ shape, and removes with the example report', async () => {
    const registration = {
      ...WIRE.register.custom,
      upstream: { baseUrl: upstreamUrl },
      expiresAt: Date.now() + 60_000,
    };
    expect((await call('PUT', `/judges/${JUDGE}`, registration)).status).toBe(204);

    const path = `/judges/${JUDGE}/chat/completions`;
    upstreamStatus = 200;
    const answered = await call('POST', path, WIRE.complete.request);
    expect(answered.status).toBe(200);
    expect(shapeOf(answered.json)).toEqual(shapeOf(WIRE.complete.answered));
    expect(answered.json).toEqual(WIRE.complete.answered);

    upstreamStatus = 503;
    const unmetered = await call('POST', path, WIRE.complete.request);
    expect(unmetered.status).toBe(200);
    expect(shapeOf(unmetered.json)).toEqual(shapeOf(WIRE.complete.unmetered));

    const refused = await call('POST', path, { ...WIRE.complete.request, model: 'other/model' });
    expect({ status: refused.status, body: refused.json }).toEqual(WIRE.complete.refused);

    const removed = await call('DELETE', `/judges/${JUDGE}`);
    expect(removed.status).toBe(200);
    const report = removed.json as { usage: unknown; log: unknown[] };
    expect(shapeOf(report.usage)).toEqual(shapeOf(WIRE.remove.usage));
    // Both forwarded calls count; the refused one never reached an upstream.
    expect(report.usage).toMatchObject({ calls: 2, totalTokens: 930 });
    // The answered call's entry is the example's; the other two are its refusals.
    expect(shapeOf(report.log[0])).toEqual(shapeOf(WIRE.remove.log[0]));
    expect(Object.keys(report).sort()).toEqual(Object.keys(WIRE.remove).sort());
  });
});
