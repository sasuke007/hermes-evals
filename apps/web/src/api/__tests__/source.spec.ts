import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import {
  apiMode,
  fixture,
  fixtureFailure,
  hasScenario,
  livePath,
  scenario,
  SCENARIO_STORAGE_KEY,
  withQuery,
} from '@/api/source';
import { setScenario, settledWithin } from './scenario';

describe('apiMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('serves fixtures under VITE_API_MODE=fixtures (vitest.config.ts sets it)', () => {
    expect(apiMode).toBe('fixtures');
    expect(livePath('/system/events')).toBeNull();
  });

  it('calls the real API by default', async () => {
    vi.stubEnv('VITE_API_MODE', '');
    vi.resetModules();
    const source = await import('@/api/source');
    expect(source.apiMode).toBe('live');
    expect(source.livePath('/system/events')).toBe('/system/events');
  });
});

describe('scenario()', () => {
  beforeEach(() => setScenario(null));

  it('is null without a scenario', () => {
    expect(scenario()).toBeNull();
  });

  it('reads ?scenario= and remembers it for the tab', () => {
    setScenario('paused-ceiling');
    expect(scenario()).toBe('paused-ceiling');
    expect(sessionStorage.getItem(SCENARIO_STORAGE_KEY)).toBe('paused-ceiling');
    window.history.replaceState({}, '', '/experiments');
    expect(scenario()).toBe('paused-ceiling');
  });

  it('forgets it with ?scenario=clear', () => {
    setScenario('empty');
    expect(scenario()).toBe('empty');
    window.history.replaceState({}, '', '/?scenario=clear');
    expect(scenario()).toBeNull();
    window.history.replaceState({}, '', '/');
    expect(scenario()).toBeNull();
    expect(sessionStorage.getItem(SCENARIO_STORAGE_KEY)).toBeNull();
  });

  it('activates several comma-separated scenarios', () => {
    setScenario('paused-provider,nous-not-connected');
    expect(hasScenario('paused-provider')).toBe(true);
    expect(hasScenario('nous-not-connected')).toBe(true);
    expect(hasScenario('paused')).toBe(false);
  });
});

describe('fixture()', () => {
  beforeEach(() => setScenario(null));

  it('resolves with a deep copy of the value or of what the function returns', async () => {
    const shared = { rows: [{ id: 'a' }] };
    const copy = await fixture(shared);
    expect(copy).toEqual(shared);
    copy.rows[0]!.id = 'changed';
    expect(shared.rows[0]!.id).toBe('a');
    await expect(fixture(() => 42)).resolves.toBe(42);
  });

  it('never resolves under the loading scenario', async () => {
    setScenario('loading');
    expect(await settledWithin(fixture({ ok: true }))).toBe('pending');
    expect(await settledWithin(fixtureFailure('POST /api/x', 409, 'no'))).toBe('pending');
  });

  it('rejects with a realistic ApiError under the error scenario', async () => {
    setScenario('error');
    const err = await fixture([], { request: 'GET /api/experiments' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).toBe(
      'GET /api/experiments → 502 · upstream api:8080 connection refused',
    );
  });

  it('lets a call name its own error', async () => {
    setScenario('error');
    await expect(
      fixture(1, {
        request: 'GET /api/suites',
        error: { status: 503, detail: 'database is down' },
      }),
    ).rejects.toThrow('GET /api/suites → 503 · database is down');
  });

  it('fixtureFailure rejects like the API', async () => {
    await expect(
      fixtureFailure('POST /api/experiments', 409, 'Nous Portal is not connected'),
    ).rejects.toThrow('POST /api/experiments → 409 · Nous Portal is not connected');
  });
});

describe('withQuery()', () => {
  it('drops empty values, joins arrays and turns booleans into 1 or 0', () => {
    expect(
      withQuery('/x', {
        a: 'b',
        n: 3,
        list: ['p', 'q'],
        on: true,
        off: false,
        none: undefined,
        nil: null,
      }),
    ).toBe('/x?a=b&n=3&list=p%2Cq&on=1&off=0');
    expect(withQuery('/x', {})).toBe('/x');
  });
});
