<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ExperimentStatus } from '@hermes-evals/shared';
import LiveIndicator from '@/components/ui/LiveIndicator.vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import type { LiveState } from '@/components/ui/types';
import { formatClock } from '@/lib/format';

/**
 * The live status at the end of the experiment's tab row (OverviewRunning): "Live · updated
 * 15:23:42" while it runs, "Paused · in-flight runs finishing" while paused, the stream's
 * Reconnecting (attempt 3) or Offline · Retry whatever the status, and a brief "Finished" when
 * the experiment completes in front of the user. Nothing for an experiment that was already
 * completed or failed.
 */
const props = withDefaults(
  defineProps<{
    status: ExperimentStatus;
    /** The stream's state: live, reconnecting or offline. */
    stream: LiveState;
    attempt?: number | null;
    lastEventAt?: string | null;
    /** Runs still running, executed or scoring. */
    inFlight?: number;
  }>(),
  { attempt: null, lastEventAt: null, inFlight: 0 },
);
defineEmits<{ retry: [] }>();

const finishedHere = ref(false);
watch(
  () => props.status,
  (status, previous) => {
    finishedHere.value = status === 'completed' && previous === 'running';
  },
);

const mode = computed<'stream' | 'live' | 'paused' | 'finished' | null>(() => {
  if (props.stream === 'reconnecting' || props.stream === 'offline') return 'stream';
  if (props.status === 'running') return 'live';
  if (props.status === 'paused') return 'paused';
  return finishedHere.value ? 'finished' : null;
});
/** After "Live", outside its live region: the time moves with every event. */
const liveDetail = computed(() =>
  props.lastEventAt ? `updated ${formatClock(props.lastEventAt)}` : null,
);
</script>

<template>
  <LiveIndicator
    v-if="mode === 'stream'"
    :state="stream"
    :attempt="attempt"
    :last-event-at="lastEventAt"
    data-testid="experiment-live"
    @retry="$emit('retry')"
  />
  <LiveIndicator
    v-else-if="mode === 'live'"
    state="live"
    :detail="liveDetail"
    data-testid="experiment-live"
  />
  <LiveIndicator v-else-if="mode === 'finished'" state="finished" data-testid="experiment-live" />
  <span
    v-else-if="mode === 'paused'"
    class="inline-flex h-24 items-center gap-8 text-12 whitespace-nowrap text-text-2"
    role="status"
    data-testid="experiment-live"
    data-state="paused"
  >
    <StatusDot tone="que" mode="hollow" />
    <span>{{ inFlight > 0 ? 'Paused · in-flight runs finishing' : 'Paused' }}</span>
  </span>
</template>
