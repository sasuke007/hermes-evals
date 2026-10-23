/**
 * Platform health for the AppShell status zone and the System page: the running summary for
 * the live pill, worker presence, the sandbox self-test, and the System dot's attention flag.
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { getSandboxStatus, getSystemSummary } from '@/api/system';
import {
  WORKER_TIMEOUT_MS,
  type RunningSummary,
  type SandboxStatus,
  type SystemSummary,
} from '@/api/types/system';
import { useProvidersStore } from './providers';

export const SYSTEM_POLL_INTERVAL_MS = 5_000;

const NOTHING_RUNNING: RunningSummary = { count: 0, scored: 0, total: 0, experiments: [] };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useSystemStore = defineStore('system', () => {
  const summary = ref<SystemSummary | null>(null);
  const sandbox = ref<SandboxStatus | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** No worker has heartbeated in the last 60 s (computed at each load). */
  const noWorker = ref(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

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

  async function load(): Promise<void> {
    loading.value = true;
    const [summaryResult, sandboxResult] = await Promise.allSettled([
      getSystemSummary(),
      getSandboxStatus(),
    ]);
    if (summaryResult.status === 'fulfilled') {
      summary.value = summaryResult.value;
      const at = Date.now();
      noWorker.value = !summaryResult.value.workers.some(
        (w) => w.status === 'online' && at - Date.parse(w.lastHeartbeatAt) < WORKER_TIMEOUT_MS,
      );
    }
    if (sandboxResult.status === 'fulfilled') sandbox.value = sandboxResult.value;
    const failure = [summaryResult, sandboxResult].find((r) => r.status === 'rejected');
    error.value = failure ? message((failure as PromiseRejectedResult).reason) : null;
    loaded.value = loaded.value || summaryResult.status === 'fulfilled';
    loading.value = false;
  }

  /** Refresh every 5 s (the summary's own cadence), paused while the tab is hidden. */
  function startPolling(intervalMs = SYSTEM_POLL_INTERVAL_MS): void {
    if (pollTimer !== null) return;
    pollTimer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void load();
    }, intervalMs);
  }
  function stopPolling(): void {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
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
    noWorker,
    running,
    workers,
    queuedRuns,
    sandboxProven,
    failedChecks,
    runningTitle,
    attention,
    load,
    startPolling,
    stopPolling,
    dispose,
  };
});
