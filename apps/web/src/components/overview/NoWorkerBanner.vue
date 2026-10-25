<script setup lang="ts">
import { computed } from 'vue';
import type { WorkerPresence } from '@/api/types/experiments';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import { formatAgo, formatClock } from '@/lib/format';

/**
 * No worker is connected while runs wait (ExperimentStates › no worker connected): nothing
 * will start until one heartbeats again. Says when the last heartbeat was and which service to
 * check.
 */
const props = defineProps<{ worker: WorkerPresence; queued: number }>();

const title = computed(
  () =>
    `No worker is connected. ${props.queued} queued ${props.queued === 1 ? 'run' : 'runs'} will not start.`,
);
const heartbeat = computed(() =>
  props.worker.lastHeartbeatAt
    ? `last worker heartbeat ${formatClock(props.worker.lastHeartbeatAt)} · ${formatAgo(props.worker.lastHeartbeatAt)}`
    : 'no worker has sent a heartbeat yet',
);
</script>

<template>
  <ErrorBanner tone="error" :title="title" :detail="heartbeat" data-testid="no-worker-banner">
    <template #hint>
      Check the <code>worker</code> service: <code>docker compose ps worker</code> then
      <code>docker compose logs worker</code>
    </template>
  </ErrorBanner>
</template>
