/**
 * Platform health for the AppShell status zone and the System page: the running summary for
 * the live pill, worker presence, the sandbox self-test, and the System dot's attention flag.
 *
 * Live mode streams the summary from GET /system/events (a `summary` event on connect and
 * every 5 s) and reads the sandbox every 30 s; when the stream drops, `liveState` turns
 * reconnecting, then offline, and the values freeze at the last update until it is back
 * (then the store reloads). Fixtures mode polls GET /system/summary every 5 s instead.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  SYSTEM_EVENT_NAMES,
  SystemEventSchema,
  getSandboxStatus,
  getSystemSummary,
  systemEventsPath,
} from '@/api/system';
import {
  WORKER_TIMEOUT_MS,
  type RunningSummary,
  type SandboxStatus,
  type SystemSummary,
} from '@/api/types/system';
import { isApiError } from '@/api/client';
import { hasScenario } from '@/api/source';
import { useSse } from '@/composables/useSse';
import { useProvidersStore } from './providers';

export const SYSTEM_POLL_INTERVAL_MS = 5_000;
/** The sandbox report changes only when a worker starts: read it now and then. */
export const SANDBOX_POLL_INTERVAL_MS = 30_000;

const NOTHING_RUNNING: RunningSummary = { count: 0, scored: 0, total: 0, experiments: [] };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export const useSystemStore = defineStore('system', () => {
  const summary = ref<SystemSummary | null>(null);
  const sandbox = ref<SandboxStatus | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  /** The last failure of either read, for the shell; the page shows the two below. */
  const error = ref<string | null>(null);
  /** GET /system/summary (or the stream) failed: the values are the last good ones. */
  const summaryError = ref<string | null>(null);
  /**
   * GET /system/sandbox failed. A 404 means no live worker has reported a self-test, and the
   * report is cleared: an offline worker's report proves nothing about the machine now.
   */
  const sandboxError = ref<string | null>(null);
  /** The sandbox read answered 404: no live worker has reported a self-test. */
  const sandboxMissing = ref(false);
  /** No worker has heartbeated in the last 60 s (computed at each summary). */
  const noWorker = ref(false);
  /** When the last summary arrived (from the stream or a load). */
  const updatedAt = ref<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let sandboxTimer: ReturnType<typeof setInterval> | null = null;

  function applySummary(next: SystemSummary): void {
    summary.value = next;
    const at = Date.now();
    updatedAt.value = new Date(at).toISOString();
    noWorker.value = !next.workers.some(
      (w) => w.status === 'online' && at - Date.parse(w.lastHeartbeatAt) < WORKER_TIMEOUT_MS,
    );
    loaded.value = true;
  }

  /** The summary stream (live mode only; null path in fixtures mode). */
  const live = useSse(systemEventsPath, SystemEventSchema, {
    events: SYSTEM_EVENT_NAMES,
    immediate: false,
    onEvent: (event) => {
      applySummary(event.summary);
      summaryError.value = null;
      error.value = sandboxError.value;
    },
    onReconnect: () => void load(),
  });

  const running = computed<RunningSummary>(() => summary.value?.running ?? NOTHING_RUNNING);
  const workers = computed(() => summary.value?.workers ?? []);
  const queuedRuns = computed(() => summary.value?.queuedRuns ?? 0);
  /** Unknown counts as proven, so the dot does not flash amber before the first answer. */
  const sandboxProven = computed(() => sandbox.value?.proven ?? true);
  const failedChecks = computed(() => sandbox.value?.checks.filter((c) => !c.passed) ?? []);
  /** Tooltip of the live pill: "Live: MCP vs baseline, invoices-v1 (87 / 120) · …". */
  const runningTitle = computed(() =>
    running.value.experiments.length
      ? `Live: ${running.value.experiments
          .map((e) => `${e.name} (${e.scored} / ${e.total})`)
          .join(' · ')}`
      : '',
  );
  /** The System dot: amber when model access, the sandbox or the worker needs attention. */
  const attention = computed(() => {
    const providers = useProvidersStore();
    return (
      providers.needsAttention ||
      providers.bannerKind !== 'none' ||
      !sandboxProven.value ||
      noWorker.value
    );
  });
  /**
   * The summary stream: live, reconnecting or offline (idle in fixtures mode, where the
   * stream-lost scenario draws it reconnecting at attempt 3 and stream-offline draws it
   * offline, as after 30 s without it).
   */
  const fixtureStream =
    systemEventsPath !== null
      ? null
      : hasScenario('stream-offline')
        ? ('offline' as const)
        : hasScenario('stream-lost')
          ? ('reconnecting' as const)
          : null;
  const liveState = computed(() => fixtureStream ?? live.state.value);
  const liveAttempt = computed(() => (fixtureStream ? 3 : live.attempt.value));
  const lastUpdateAt = computed(() => updatedAt.value);

  function applySandbox(result: PromiseSettledResult<SandboxStatus>): void {
    if (result.status === 'fulfilled') {
      sandbox.value = result.value;
      sandboxError.value = null;
      sandboxMissing.value = false;
      return;
    }
    sandboxMissing.value = isApiError(result.reason) && result.reason.status === 404;
    if (sandboxMissing.value) sandbox.value = null;
    sandboxError.value = message(result.reason);
  }

  async function load(): Promise<void> {
    loading.value = true;
    const [summaryResult, sandboxResult] = await Promise.allSettled([
      getSystemSummary(),
      getSandboxStatus(),
    ]);
    if (summaryResult.status === 'fulfilled') {
      applySummary(summaryResult.value);
      summaryError.value = null;
    } else {
      summaryError.value = message(summaryResult.reason);
    }
    applySandbox(sandboxResult);
    error.value = summaryError.value ?? sandboxError.value;
    loading.value = false;
  }

  async function loadSandbox(): Promise<void> {
    const [result] = await Promise.allSettled([getSandboxStatus()]);
    applySandbox(result);
    error.value = summaryError.value ?? sandboxError.value;
  }

  /**
   * Keep the summary current: the stream in live mode (plus the sandbox every 30 s), a 5 s
   * poll in fixtures mode. Polls pause while the tab is hidden.
   */
  function startPolling(intervalMs = SYSTEM_POLL_INTERVAL_MS): void {
    if (systemEventsPath !== null) {
      live.start();
      if (sandboxTimer === null) {
        sandboxTimer = setInterval(() => {
          if (!isHidden()) void loadSandbox();
        }, SANDBOX_POLL_INTERVAL_MS);
      }
      return;
    }
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      if (!isHidden()) void load();
    }, intervalMs);
  }
  function stopPolling(): void {
    live.stop();
    if (pollTimer !== null) clearInterval(pollTimer);
    if (sandboxTimer !== null) clearInterval(sandboxTimer);
    pollTimer = null;
    sandboxTimer = null;
  }
  /** Offline · Retry on the stream. */
  function retryLive(): void {
    live.retry();
  }
  function dispose(): void {
    stopPolling();
  }

  return {
    summary,
    sandbox,
    loaded,
    loading,
    error,
    summaryError,
    sandboxError,
    sandboxMissing,
    noWorker,
    running,
    workers,
    queuedRuns,
    sandboxProven,
    failedChecks,
    runningTitle,
    attention,
    liveState,
    liveAttempt,
    lastUpdateAt,
    load,
    loadSandbox,
    startPolling,
    stopPolling,
    retryLive,
    dispose,
  };
});
