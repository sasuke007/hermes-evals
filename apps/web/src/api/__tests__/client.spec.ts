/**
 * client.ts against a stubbed fetch: every response parsed with its schema, every failure an
 * ApiError carrying the API's own message and issues, the CSRF header on every state-changing
 * call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiGet, apiSend, errorMessage, isApiError } from '@/api/client';

interface Call {
  url: string;
  init: RequestInit;
}
let calls: Call[] = [];

function respond(status: number, body: unknown, contentType = 'application/json') {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, {
      status,
      headers: { 'content-type': contentType },
    });
  });
}

const ThingSchema = z.object({ id: z.string(), n: z.number() });

beforeEach(() => {
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('apiGet', () => {
  it('GETs /api + path and parses the answer with its schema', async () => {
    respond(200, { id: 'a', n: 1, extra: true });
    await expect(apiGet('/things/a?x=1', ThingSchema)).resolves.toEqual({ id: 'a', n: 1 });
    expect(calls[0]!.url).toBe('/api/things/a?x=1');
    expect(calls[0]!.init.method).toBe('GET');
    expect((calls[0]!.init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('throws the API message and issues for an error answer', async () => {
    respond(400, {
      statusCode: 400,
      message: 'Validation failed',
      issues: [{ path: 'headers.0.env', message: 'DATABASE_URL is a platform variable' }],
    });
    const err = await apiGet('/things?x=1', ThingSchema).catch((e: unknown) => e);
    expect(isApiError(err)).toBe(true);
    const api = err as ApiError;
    expect(api.status).toBe(400);
    expect(api.kind).toBe('http');
    expect(api.detail).toBe('Validation failed');
    expect(api.message).toBe('GET /api/things → 400 · Validation failed');
    expect(api.issueFor('headers.0.env')).toBe('DATABASE_URL is a platform variable');
    expect(api.issueFor('name')).toBeNull();
  });

  it('quotes a body that is not the API error shape (a proxy page)', async () => {
    respond(502, '<html>Bad Gateway</html>', 'text/html');
    await expect(apiGet('/things', ThingSchema)).rejects.toThrow(
      'GET /api/things → 502 · <html>Bad Gateway</html>',
    );
  });

  it('reports a network failure as status 0', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = (await apiGet('/things', ThingSchema).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('network');
    expect(err.status).toBe(0);
    expect(err.message).toBe('GET /api/things → 0 · Failed to fetch');
  });

  it('fails loudly when the answer breaks its contract', async () => {
    respond(200, { id: 'a', n: 'one' });
    const err = (await apiGet('/things/a', ThingSchema).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('contract');
    expect(err.detail).toMatch(/^the response does not match its contract \(n: /);
    expect(err.issues[0]!.path).toBe('n');
  });

  it('refuses a body that is not JSON', async () => {
    respond(200, 'not json', 'text/plain');
    const err = (await apiGet('/things/a', ThingSchema).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('contract');
    expect(err.detail).toBe('the response is not JSON');
  });
});

describe('apiSend', () => {
  it('sends JSON with X-Requested-With and parses the answer', async () => {
    respond(200, { id: 'b', n: 2 });
    const out = await apiSend('POST', '/things', { name: 'b' }, ThingSchema);
    expect(out).toEqual({ id: 'b', n: 2 });
    const { url, init } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(url).toBe('/api/things');
    expect(init.method).toBe('POST');
    expect(headers['x-requested-with']).toBe('hermes-evals');
    expect(headers['content-type']).toBe('application/json');
    expect(init.body).toBe('{"name":"b"}');
  });

  it('sends {} when there is no body, and accepts 204 without a schema', async () => {
    respond(204, null);
    await expect(apiSend('DELETE', '/things/b')).resolves.toBeUndefined();
    expect(calls[0]!.init.body).toBe('{}');
  });

  it('sends FormData as multipart (no JSON content type)', async () => {
    respond(200, { id: 'c', n: 3 });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.zip');
    await apiSend('POST', '/resources/skills/validate', form, ThingSchema);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(headers['x-requested-with']).toBe('hermes-evals');
    expect(calls[0]!.init.body).toBe(form);
  });

  it('names the request without its query in a refusal', async () => {
    respond(409, { statusCode: 409, message: 'Nous Portal is not connected' });
    await expect(apiSend('POST', '/experiments?dry=1', {}, ThingSchema)).rejects.toThrow(
      'POST /api/experiments → 409 · Nous Portal is not connected',
    );
  });
});

describe('errorMessage', () => {
  it('reads any thrown value', () => {
    expect(errorMessage(new ApiError(502, 'GET /api/x', 'down'))).toBe('GET /api/x → 502 · down');
    expect(errorMessage('plain')).toBe('plain');
  });
});
