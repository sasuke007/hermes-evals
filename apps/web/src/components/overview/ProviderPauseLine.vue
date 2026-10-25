<script setup lang="ts">
import { computed } from 'vue';
import StatusDot from '@/components/ui/StatusDot.vue';
import type { ProviderState } from '@/components/runs/modelAccess';
import { formatHourMinute } from './overview';

/**
 * Paused because a provider disconnected (ExperimentStates › paused: provider disconnected):
 * the worker checks the provider before every run, so a lost login pauses the experiment
 * instead of failing runs. Amber while the provider is down; once it is back the line turns
 * neutral and says to Resume, since reconnecting never resumes by itself.
 */
const props = withDefaults(
  defineProps<{
    pausedAt: string | null;
    provider: ProviderState;
    /** When this page saw the provider come back; null when it was already back. */
    reconnectedAt?: string | null;
  }>(),
  { reconnectedAt: null },
);

const lead = computed(() => {
  const at = props.pausedAt ? ` at ${formatHourMinute(props.pausedAt)}` : '';
  const what = props.provider.connectable
    ? `${props.provider.name} is not connected.`
    : `${props.provider.name} is not available.`;
  return `Paused${at}: ${what}`;
});
const rest = computed(() => {
  if (!props.provider.ready) return 'In-flight runs finished; no attempts were used.';
  return props.reconnectedAt
    ? `Reconnected at ${formatHourMinute(props.reconnectedAt)}. Resume to continue.`
    : 'Reconnected. Resume to continue.';
});
</script>

<template>
  <div
    role="status"
    class="flex items-start gap-10 rounded-6 border px-12 py-10"
    :class="provider.ready ? 'border-border bg-surface-2' : 'border-ung bg-ung-soft'"
    data-testid="provider-pause"
    :data-ready="provider.ready ? 'true' : 'false'"
  >
    <span class="mt-6 flex"
      ><StatusDot
        :tone="provider.ready ? 'pass' : 'ung'"
        :mode="provider.ready ? 'solid' : 'hollow'"
    /></span>
    <span
      ><b :class="provider.ready ? 'text-text' : 'text-ung-text'">{{ lead }}</b>
      <span class="text-text-2">{{ ` ${rest}` }}</span></span
    >
  </div>
</template>
