<script setup lang="ts">
import { computed, ref } from 'vue';
import { useIntervalFn } from '@vueuse/core';
import EmptyState from '@/components/ui/EmptyState.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import SkeletonRows from '@/components/ui/SkeletonRows.vue';
import StatusChip from '@/components/ui/StatusChip.vue';
import type { SkeletonColumn } from '@/components/ui/types';
import { MISSING, formatAgo, formatClock } from '@/lib/format';
import { useSystemStore } from '@/stores/system';
import SystemSection from './SystemSection.vue';

/**
 * System › Workers: every worker the summary stream reports (the API also lists the last one
 * heard from when none is live, so the page can say when it was seen). A worker heartbeats
 * every 10 s and counts as gone after 60 s; then a red alert says queued runs will not start
 * and how to check the service. Concurrency is what the worker really runs at once: its
 * WORKER_CONCURRENCY capped at its trial slots.
 */
const system = useSystemStore();
/** "3 s ago" stays true between summaries. */
const now = ref(Date.now());
useIntervalFn(() => (now.value = Date.now()), 1000);

const SKELETON: SkeletonColumn[] = [
  { width: 90 },
  { width: 60, height: 16 },
  { width: 140 },
  { width: 20, align: 'right' },
  { width: 50, align: 'right' },
  { width: 60, height: 16 },
];

/** "15:31:04 · 3 s ago". */
function beat(at: string): string {
  return `${formatClock(at)} · ${formatAgo(at, now.value)}`;
}

const rows = computed(() =>
  system.workers.map((w) => ({
    ...w,
    beat: beat(w.lastHeartbeatAt),
    slots:
      w.slotsInUse === null || w.slotsTotal === null ? null : `${w.slotsInUse} of ${w.slotsTotal}`,
    capped: w.effectiveConcurrency !== w.concurrency,
  })),
);

/** The newest heartbeat any worker sent, for the no-worker alert. */
const lastBeat = computed(() => {
  const times = system.workers.map((w) => w.lastHeartbeatAt).sort();
  const latest = times[times.length - 1];
  return latest ? `last worker heartbeat ${beat(latest)}` : null;
});
const queuedLine = computed(() => {
  const n = system.queuedRuns;
  if (n === 0) return '';
  return n === 1 ? ' 1 queued run will not start.' : ` ${n} queued runs will not start.`;
});

const firstLoad = computed(() => !system.loaded);
</script>

<template>
  <SystemSection id="workers" title="Workers" caption="heartbeat every 10 s">
    <ErrorBanner
      v-if="system.summaryError && firstLoad"
      title="Could not load workers"
      :detail="system.summaryError"
      hint="Check that the api service is running: docker compose ps api."
      retry-label="Retry"
      @retry="system.load()"
    />
    <ErrorBanner v-else-if="!firstLoad && system.noWorker" data-testid="no-worker-alert">
      <template #title>No worker is connected.{{ queuedLine }}</template>
      <code v-if="lastBeat" class="text-text-2">{{ lastBeat }}</code>
      <template #hint
        >Check the <code>worker</code> service: <code>docker compose ps worker</code> then
        <code>docker compose logs worker</code></template
      >
    </ErrorBanner>
    <div
      v-if="!(firstLoad && system.summaryError)"
      class="tbl"
      :aria-busy="firstLoad ? 'true' : undefined"
    >
      <table class="dt loose static" aria-labelledby="workers">
        <thead>
          <tr>
            <th>Worker</th>
            <th>Status</th>
            <th>Last heartbeat</th>
            <th class="text-right">Concurrency</th>
            <th class="text-right">Trial slots in use</th>
            <th>Sandbox</th>
          </tr>
        </thead>
        <tbody>
          <SkeletonRows v-if="firstLoad" :columns="SKELETON" :rows="1" />
          <tr v-else-if="rows.length === 0">
            <td colspan="6" class="p-0">
              <EmptyState
                :panel="false"
                title="No worker has connected yet"
                body="Start one with: docker compose up -d worker"
              />
            </td>
          </tr>
          <tr
            v-for="w in rows"
            v-else
            :key="w.id"
            :class="{ 'opacity-60': w.status === 'offline' }"
            :data-worker="w.id"
          >
            <td class="font-mono font-semibold">{{ w.id }}</td>
            <td><StatusChip kind="worker" :status="w.status" /></td>
            <td class="font-mono text-12">{{ w.beat }}</td>
            <td
              class="text-right font-mono"
              :title="
                w.capped
                  ? `WORKER_CONCURRENCY is ${w.concurrency}; the worker runs ${w.effectiveConcurrency} at once, one per trial slot`
                  : undefined
              "
            >
              {{ w.effectiveConcurrency
              }}<span v-if="w.capped" class="text-text-3"> of {{ w.concurrency }}</span>
            </td>
            <td class="text-right font-mono">
              <template v-if="w.slots">{{ w.slots }}</template>
              <span v-else class="text-text-3">{{ MISSING }}</span>
            </td>
            <td>
              <StatusChip
                kind="sandbox"
                :status="w.sandboxProven ? 'proven' : 'not_proven'"
                :dot="false"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </SystemSection>
</template>
