import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGuardServer } from '../src/server.js';
import { trialBody, VERIFIER_NAME, verifierBody } from './fixtures.js';

interface Seen {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const TRIAL_NAME = 'hermes-evals-run-01K8ZQ7M3V5X9C2B4N6P8R0T1W';
const TRIAL_ID = 'a'.repeat(64);
const POSTGRES_ID = 'b'.repeat(64);
const MISSING_ID = 'c'.repeat(64);

const dir = mkdtempSync(join(tmpdir(), 'guard-'));
const engineSocket = join(dir, 'engine.sock');
const guardSocket = join(dir, 'guard.sock');
const seen: Seen[] = [];

/** A fake Docker Engine that records what reaches it. */
const engine = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = req.url!;
    seen.push({ method: req.method!, url, body, headers: req.headers });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.startsWith('/images/')) return json(200, { Id: 'sha256:pinned' });
    if (url === `/containers/${TRIAL_NAME}/json` || url === `/containers/${TRIAL_ID}/json`)
      return json(200, { Id: TRIAL_ID, Config: { Labels: { 'hermes-evals.role': 'trial' } } });
    if (url === `/containers/${POSTGRES_ID}/json`)
      return json(200, { Id: POSTGRES_ID, Config: { Labels: {} } });
    if (url.startsWith('/containers/create')) return json(201, { Id: TRIAL_ID });
    if (
      url.startsWith('/containers/') &&
      url.endsWith('/json') &&
      !url.startsWith('/containers/json')
    )
      return json(404, { message: 'no such container' });
    if (url.startsWith(`/containers/${TRIAL_ID}/wait`)) {
      // The Engine answers with headers once the wait is registered, and the body at exit.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      setTimeout(() => res.end('{"StatusCode":0}'), 400);
      return;
    }
    if (url.startsWith(`/containers/${TRIAL_ID}/logs`)) {
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' });
      res.write('first ');
      setTimeout(() => res.end('second'), 20);
      return;
    }
    return json(200, {});
  });
});

const guard = createGuardServer({
  trialImage: 'hermes-evals/trial:v0.22.4-4d04303',
  trialVolume: 'hermes-evals-trials',
  trialNetworks: ['hermes-evals-trial-0', 'hermes-evals-trial-1'],
  upstreamSocket: engineSocket,
  log: () => {},
});

function call(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: guardSocket,
      method,
      path,
      headers: { 'content-type': 'application/json', ...extraHeaders },
    });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => engine.listen(engineSocket, resolve));
  await new Promise<void>((resolve) => guard.listen(guardSocket, resolve));
});

afterAll(async () => {
  await new Promise((resolve) => guard.close(resolve));
  await new Promise((resolve) => engine.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

describe('guard server', () => {
  it('never forwards a refused create body to the engine', async () => {
    const body = trialBody() as { HostConfig: Record<string, unknown> };
    body.HostConfig.Privileged = true;
    const res = await call('POST', `/v1.45/containers/create?name=${TRIAL_NAME}`, body);
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/Privileged/);
    expect(seen).toEqual([]);
  });

  it('forwards an allowed create with the image pinned to its id', async () => {
    const res = await call('POST', `/v1.45/containers/create?name=${TRIAL_NAME}`, trialBody(), {
      'x-registry-auth': 'secret',
    });
    expect(res.status).toBe(201);
    const create = seen.find((s) => s.url.startsWith('/containers/create'));
    expect(JSON.parse(create!.body).Image).toBe('sha256:pinned');
    expect(create!.headers['x-registry-auth']).toBeUndefined();
  });

  it('checks a verifier container against the verifier shape and forwards it pinned', async () => {
    const asTrial = await call('POST', `/containers/create?name=${TRIAL_NAME}`, verifierBody());
    expect(asTrial.status).toBe(403);
    const wrongShape = await call('POST', `/containers/create?name=${VERIFIER_NAME}`, trialBody());
    expect(wrongShape.status).toBe(403);
    expect(seen).toEqual([]);
    const res = await call('POST', `/containers/create?name=${VERIFIER_NAME}`, verifierBody());
    expect(res.status).toBe(201);
    const create = seen.find((s) => s.url.startsWith('/containers/create'));
    expect(create!.url).toBe(`/containers/create?name=${VERIFIER_NAME}`);
    expect(JSON.parse(create!.body)).toMatchObject({
      Image: 'sha256:pinned',
      HostConfig: { NetworkMode: 'none' },
    });
  });

  it('refuses operations on containers that are not trials', async () => {
    expect((await call('POST', `/containers/${POSTGRES_ID}/stop`)).status).toBe(403);
    expect((await call('DELETE', `/containers/${POSTGRES_ID}?force=1`)).status).toBe(403);
    expect(seen.every((s) => s.url === `/containers/${POSTGRES_ID}/json`)).toBe(true);
    expect((await call('POST', `/containers/${MISSING_ID}/start`)).status).toBe(404);
  });

  it('refuses short id prefixes and names that are not trial names', async () => {
    expect((await call('POST', '/containers/aaaa/stop')).status).toBe(403);
    expect((await call('POST', '/containers/postgres/stop')).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('sends the operation to the id the label check resolved, with no client headers', async () => {
    const res = await call('POST', `/containers/${TRIAL_NAME}/stop?t=5`, undefined, {
      'x-registry-auth': 'secret',
    });
    expect(res.status).toBe(200);
    const stop = seen.find((s) => s.url.includes('/stop'));
    expect(stop!.url).toBe(`/containers/${TRIAL_ID}/stop?t=5`);
    expect(stop!.headers['x-registry-auth']).toBeUndefined();
  });

  it('refuses a body on any call but create', async () => {
    expect((await call('POST', `/containers/${TRIAL_ID}/start`, { anything: 1 })).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('refuses query parameters the lifecycle does not use', async () => {
    expect((await call('POST', `/containers/${TRIAL_ID}/kill?signal=SIGSTOP`)).status).toBe(403);
    expect((await call('GET', '/info?x=1')).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('answers malformed requests instead of crashing', async () => {
    expect((await call('GET', '/images/%E0%A4%A/json')).status).toBe(400);
    expect((await call('GET', '/v1.45/_ping')).status).toBe(200);
  });

  it('streams logs of a trial container through', async () => {
    const res = await call('GET', `/containers/${TRIAL_NAME}/logs?follow=1&stdout=1`);
    expect(res.status).toBe(200);
    expect(res.text).toBe('first second');
  });

  it('passes response headers on at once, before any body arrives', async () => {
    const started = Date.now();
    const headersAt = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        socketPath: guardSocket,
        method: 'POST',
        path: `/containers/${TRIAL_ID}/wait?condition=next-exit`,
      });
      req.on('response', (res) => {
        resolve(Date.now() - started);
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });
    expect(headersAt).toBeLessThan(200);
  });

  it('refuses endpoints outside the trial lifecycle without touching the engine', async () => {
    expect((await call('POST', `/containers/${TRIAL_ID}/exec`)).status).toBe(403);
    expect((await call('POST', '/networks/create', { Name: 'x' })).status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('only ever lists trial containers', async () => {
    await call('GET', '/containers/json?all=1');
    const list = new URL(seen[0]!.url, 'http://engine');
    expect(JSON.parse(list.searchParams.get('filters')!)).toEqual({
      label: ['hermes-evals.role=trial'],
    });
  });
});
