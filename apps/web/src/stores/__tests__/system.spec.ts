/**
 * The system store in live mode: the summary comes from GET /system/events, and the stream's
 * state reaches the AppShell pill. Fixtures mode polls instead (AppShell.spec covers it).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { sandboxFixture, systemSummaryFixture } from '@/fixtures/system';
import { FakeEventSource } from '@/composables/__tests__/fakeEventSource';

beforeAll(() => {
  vi.stubEnv('VITE_API_MODE', 'live');
  vi.resetModules();
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
  // load() on reconnect: answer like the API would.
  vi.stubGlobal('fetch', async (url: string) => {
    const body = url.endsWith('/system/summary')
      ? systemSummaryFixture()
      : { statusCode: 503, message: 'not in this test' };
    return new Response(JSON.stringify(body), {
      status: url.endsWith('/system/summary') ? 200 : 503,
      headers: { 'content-type': 'application/json' },
    });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function liveStore() {
  const { useSystemStore } = await import('@/stores/system');
  setActivePinia(createPinia());
  return useSystemStore();
}

describe('system store, live', () => {
  it('streams the summary and says how the stream is doing', async () => {
    const store = await liveStore();
    store.startPolling();
    const es = FakeEventSource.last;
    expect(es.url).toBe('/api/system/events');
    es.open();
    expect(store.liveState).toBe('live');
    const summary = systemSummaryFixture();
    es.emit('summary', { type: 'summary', at: '2026-10-25T14:00:00Z', summary });
    expect(store.running.count).toBe(summary.running.count);
    expect(store.running.count).toBeGreaterThan(0);
    expect(store.lastUpdateAt).not.toBeNull();

    es.fail();
    expect(store.liveState).toBe('reconnecting');
    expect(store.liveAttempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.last.open();
    expect(store.liveState).toBe('live');
    store.stopPolling();
    expect(FakeEventSource.last.closed).toBe(true);
  });

  it('drops a summary that breaks its contract', async () => {
    const store = await liveStore();
    store.startPolling();
    FakeEventSource.last.open();
    FakeEventSource.last.emit('summary', { type: 'summary', at: 'x', summary: { running: 3 } });
    expect(store.summary).toBeNull();
    store.dispose();
  });
});

describe('system store, live reads', () => {
  /** Answers per path; anything else is a 503. */
  function answer(routes: Record<string, { status: number; body: unknown }>) {
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname.replace(/^\/api/, '');
      const hit = routes[path] ?? { status: 503, body: { statusCode: 503, message: 'down' } };
      return new Response(JSON.stringify(hit.body), {
        status: hit.status,
        headers: { 'content-type': 'application/json' },
      });
    });
  }
  const NO_WORKER = {
    status: 404,
    body: {
      statusCode: 404,
      message:
        'No worker is connected, so no isolation self-test has been reported. Start one with: docker compose up -d worker',
    },
  };

  it('clears the isolation report when no live worker has one (404), and says why', async () => {
    answer({
      '/system/summary': { status: 200, body: systemSummaryFixture() },
      '/system/sandbox': { status: 200, body: sandboxFixture() },
    });
    const store = await liveStore();
    await store.load();
    expect(store.sandbox?.proven).toBe(true);
    expect(store.sandboxError).toBeNull();

    answer({
      '/system/summary': { status: 200, body: systemSummaryFixture() },
      '/system/sandbox': NO_WORKER,
    });
    await store.loadSandbox();
    expect(store.sandbox).toBeNull();
    expect(store.sandboxMissing).toBe(true);
    expect(store.sandboxError).toBe(
      'GET /api/system/sandbox → 404 · No worker is connected, so no isolation self-test has been reported. Start one with: docker compose up -d worker',
    );
    expect(store.summaryError).toBeNull();
    expect(store.error).toBe(store.sandboxError);
  });

  it('keeps the last report when the sandbox read fails another way', async () => {
    answer({
      '/system/summary': { status: 200, body: systemSummaryFixture() },
      '/system/sandbox': { status: 200, body: sandboxFixture() },
    });
    const store = await liveStore();
    await store.load();
    answer({});
    await store.loadSandbox();
    expect(store.sandbox?.proven).toBe(true);
    expect(store.sandboxMissing).toBe(false);
    expect(store.sandboxError).toBe('GET /api/system/sandbox → 503 · down');
  });

  it('keeps the last summary when a reload fails, and says so apart from the sandbox', async () => {
    answer({
      '/system/summary': { status: 200, body: systemSummaryFixture() },
      '/system/sandbox': { status: 200, body: sandboxFixture() },
    });
    const store = await liveStore();
    await store.load();
    answer({ '/system/sandbox': { status: 200, body: sandboxFixture() } });
    await store.load();
    expect(store.running.count).toBe(2);
    expect(store.summaryError).toBe('GET /api/system/summary → 503 · down');
    expect(store.sandboxError).toBeNull();
  });
});
